import type { ResolvedConfig } from "./config/loader"
import type { Rule } from "./config/schema"
import { formatModel, matchRule } from "./match"
import { createState, type RetryState } from "./state"
import type { Logger } from "./utils/logger"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** 复查消息时用到的字段。真实 SessionMessage 是它的超集。 */
export interface TranscriptMessage {
  id: string
  type: string
  time?: { created: number; completed?: number }
  model?: ModelRef
  error?: { type: string; message: string }
  finish?: string
  text?: string
}

/** 处理器关心的事件子集。真实订阅流可以结构兼容地传进来。 */
export interface ObservedEvent {
  type: string
  created?: number
  data?: {
    sessionID?: string
    assistantMessageID?: string
    error?: { type?: string; message?: string }
    finish?: string
    reason?: string
    model?: ModelRef
    /** session.tool.called 的工具调用 id，用来按次去重。 */
    id?: string
  }
}

export interface HandlerDeps {
  events: AsyncIterable<ObservedEvent>
  prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  getSession: (sessionID: string) => Promise<{ model?: ModelRef; parentID?: string } | undefined>
  listMessages: (sessionID: string) => Promise<readonly TranscriptMessage[]>
  notify: (message: string) => void
  config: ResolvedConfig
  logger: Logger
  sleep?: (ms: number) => Promise<void>
  /** 测试注入的时钟。缺省用 Date.now。 */
  now?: () => number
  state?: RetryState
}

export interface RetainedEntries {
  tails: number
  cancels: number
  counts: number
  pending: number
  progress: number
}

interface SessionProgress {
  toolCalls: number
  seen: Set<string>
  /** 已经结束的 step 累计下来的运行时长，不含空闲和睡眠。 */
  runningMs: number
  stepStartedAt?: number
}

interface ProgressSnapshot {
  toolCalls: number
  elapsed: number
}

const CONTENT_FILTER = "provider.content-filter"
// 这些结束会打开去重闩。只有 stop 才把失败计数整段清掉。
const LATCH_FINISH = new Set(["stop", "tool-calls", "length"])
const SEEN_LIMIT = 1000

/**
 * 订阅失败事件并按规则续写。
 *
 * 没有规则时 start() 直接返回，不读消息、不调用 prompt。
 * 同一会话的任务串行；中断代数在收到失败事件时就记下，排队期间的中断不会被漏掉。
 */
export function createHandler(deps: HandlerDeps) {
  const state = deps.state ?? createState()
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? Date.now
  const tails = new Map<string, Promise<void>>()
  const cancelCounts = new Map<string, number>()
  // 该会话这一次失败已经接手，重复的 step.failed / execution.failed 都丢掉。
  const pending = new Set<string>()
  // 熔断之后还要拦住同一轮后续失败，同时把 counts 清掉，避免表一直涨。
  const stopped = new Set<string>()
  const gone = new Set<string>()
  // 上一次失败或 stop 之后的推进量。按会话累计，结算或 stop 时清掉。
  const progress = new Map<string, SessionProgress>()

  const enqueue = (
    sessionID: string,
    task: (isTail: () => boolean) => Promise<void>,
  ): Promise<void> => {
    const previous = tails.get(sessionID) ?? Promise.resolve()
    let settled!: Promise<void>
    const isTail = () => tails.get(sessionID) === settled
    settled = previous
      .then(() => task(isTail))
      .catch((error: unknown) => {
        deps.logger.warn(`处理会话 ${sessionID} 失败：${errorText(error)}`)
      })
      .finally(() => {
        if (isTail()) tails.delete(sessionID)
      })
    tails.set(sessionID, settled)
    return settled
  }

  const start = async (): Promise<void> => {
    if (deps.config.rules.length === 0) return

    // 订阅可能先回放历史。created 是毫秒时间戳，早于这一刻的失败丢掉。
    const startedAt = now()
    const waiting: Promise<void>[] = []
    for await (const event of deps.events) {
      const work = onEvent(event, startedAt)
      if (work) waiting.push(work)
    }
    await Promise.all(waiting)
  }

  const forgetSession = (sessionID: string, keepCancel: boolean): void => {
    state.recordProgress(sessionID)
    pending.delete(sessionID)
    progress.delete(sessionID)
    if (!keepCancel) cancelCounts.delete(sessionID)
  }

  const ensureProgress = (sessionID: string): SessionProgress => {
    let current = progress.get(sessionID)
    if (!current) {
      current = { toolCalls: 0, seen: new Set(), runningMs: 0 }
      progress.set(sessionID, current)
    }
    return current
  }

  const noteTool = (sessionID: string, toolID: string | undefined): void => {
    const current = ensureProgress(sessionID)
    if (toolID) {
      if (current.seen.has(toolID)) return
      if (current.seen.size >= SEEN_LIMIT) {
        const oldest = current.seen.values().next().value
        if (oldest !== undefined) current.seen.delete(oldest)
      }
      current.seen.add(toolID)
    }
    current.toolCalls += 1
  }

  const closeStep = (sessionID: string): void => {
    const current = progress.get(sessionID)
    if (!current || current.stepStartedAt === undefined) return
    current.runningMs += Math.max(0, now() - current.stepStartedAt)
    current.stepStartedAt = undefined
  }

  const beginStep = (sessionID: string): void => {
    closeStep(sessionID)
    ensureProgress(sessionID).stepStartedAt = now()
  }

  const discardStep = (sessionID: string): void => {
    const current = progress.get(sessionID)
    if (current) current.stepStartedAt = undefined
  }

  const takeProgress = (sessionID: string): ProgressSnapshot => {
    const current = progress.get(sessionID)
    const snapshot = {
      toolCalls: current?.toolCalls ?? 0,
      elapsed: current?.runningMs ?? 0,
    }
    if (current) {
      current.toolCalls = 0
      current.seen = new Set()
      current.runningMs = 0
      current.stepStartedAt = undefined
    }
    return snapshot
  }

  const onEvent = (event: ObservedEvent, startedAt: number): Promise<void> | undefined => {
    const sessionID = event.data?.sessionID
    if (!sessionID) return undefined

    if (event.type === "session.deleted") {
      gone.add(sessionID)
      stopped.delete(sessionID)
      forgetSession(sessionID, false)
      return undefined
    }

    if (event.type === "session.tool.called") {
      if (gone.has(sessionID)) return undefined
      noteTool(sessionID, event.data?.id)
      return undefined
    }

    if (event.type === "session.step.started") {
      if (gone.has(sessionID)) return undefined
      pending.delete(sessionID)
      beginStep(sessionID)
      return undefined
    }

    if (event.type === "session.execution.interrupted") {
      cancelCounts.set(sessionID, (cancelCounts.get(sessionID) ?? 0) + 1)
      // 中断不是正常收口。丢掉未关闭的计时，否则之后的空闲会被算进运行时长。
      discardStep(sessionID)
      return undefined
    }

    if (event.type === "session.step.ended") {
      const finish = event.data?.finish
      // content-filter / error 不计入运行时长，也不打开去重闩。
      if (finish === "content-filter" || finish === "error") {
        discardStep(sessionID)
        return undefined
      }
      if (!finish || !LATCH_FINISH.has(finish)) {
        // unknown 等未识别结束同样要丢掉未关闭的计时。
        discardStep(sessionID)
        return undefined
      }
      pending.delete(sessionID)
      if (finish !== "stop") {
        closeStep(sessionID)
        return undefined
      }
      // stop 是完整清零：推进量马上丢掉，失败计数等前面的任务记完再清。
      stopped.delete(sessionID)
      progress.delete(sessionID)
      return enqueue(sessionID, async () => {
        if (gone.has(sessionID)) return
        state.recordProgress(sessionID)
      })
    }

    if (event.type !== "session.step.failed" && event.type !== "session.execution.failed") {
      return undefined
    }

    const error = readError(event)
    // 只处理内容拦截。用户中断产生的 aborted 等其它失败不续写。
    if (!error || error.type !== CONTENT_FILTER) {
      // 宿主失败只发 step.failed。aborted 等非拦截失败也要停表，且不把这一步算进推进。
      discardStep(sessionID)
      return undefined
    }
    // 回放的历史失败 created 更早，丢掉，也不去占闩。
    if (typeof event.created === "number" && event.created < startedAt) return undefined
    if (gone.has(sessionID) || stopped.has(sessionID)) return undefined
    if (pending.has(sessionID)) return undefined

    pending.add(sessionID)
    const cancelToken = cancelCounts.get(sessionID) ?? 0
    // 失败的这一步也算进运行时长，再结算，避免后面的工具调用被算进来。
    closeStep(sessionID)
    const settled = takeProgress(sessionID)
    return enqueue(sessionID, (isTail) => handleFailure(sessionID, event, error, cancelToken, settled, isTail))
  }

  const handleFailure = async (
    sessionID: string,
    event: ObservedEvent,
    error: { type: string; message: string },
    cancelToken: number,
    settled: ProgressSnapshot,
    isTail: () => boolean,
  ): Promise<void> => {
    try {
      if (gone.has(sessionID) || stopped.has(sessionID)) return
      const before = await deps.listMessages(sessionID)
      // 等待消息的时候会话可能已被删除，不能再把计数写回去。
      if (gone.has(sessionID)) return
      const assistantID = event.data?.assistantMessageID
      const model = await resolveModel(sessionID, assistantID, before)
      if (!model) {
        deps.logger.debug(`会话 ${sessionID} 取不到失败请求的模型，跳过`)
        return
      }

      const matched = matchRule(deps.config.rules, { model, errorMessage: error.message })
      if (!matched) return

      const ruleIndex = deps.config.rules.indexOf(matched)
      if (
        settled.toolCalls >= matched.resetAfterToolCalls ||
        settled.elapsed >= matched.resetAfterMs
      ) {
        state.clearRule(sessionID, ruleIndex)
      }
      // 删除事件可能插在计数之前。写完再清一次，避免计数被写回去。
      if (gone.has(sessionID)) {
        state.recordProgress(sessionID)
        return
      }
      const count = state.recordFailure(sessionID, ruleIndex)
      if (gone.has(sessionID)) {
        state.recordProgress(sessionID)
        return
      }
      if (count > matched.maxRetries) {
        if (count === matched.maxRetries + 1) {
          deps.notify(
            `自动续写已停止：连续失败 ${count} 次，超过上限 ${matched.maxRetries}。原始错误仍保留：${error.message}`,
          )
        }
        stopped.add(sessionID)
        forgetSession(sessionID, !isTail())
        return
      }

      if (matched.delayMs > 0) await sleep(matched.delayMs)
      if (gone.has(sessionID)) return
      if ((cancelCounts.get(sessionID) ?? 0) !== cancelToken) {
        deps.logger.debug(`会话 ${sessionID} 在发送前被中断，跳过`)
        stopped.delete(sessionID)
        forgetSession(sessionID, !isTail())
        return
      }

      const after = await deps.listMessages(sessionID)
      if (hasUserMessageAfter(after, cutoffOf(before, assistantID, event.created))) {
        deps.logger.debug(`会话 ${sessionID} 在失败后已有新的用户消息，跳过`)
        return
      }

      await sendPrompt(sessionID, matched)
    } finally {
      // 后面还有排队任务时，中断标记要留到那个任务自己看。
      if (isTail()) cancelCounts.delete(sessionID)
    }
  }

  const resolveModel = async (
    sessionID: string,
    assistantID: string | undefined,
    messages: readonly TranscriptMessage[],
  ): Promise<string | undefined> => {
    const fromMessage = assistantID ? formatModel(findById(messages, assistantID)?.model) : undefined
    if (fromMessage) return fromMessage

    try {
      const session = await deps.getSession(sessionID)
      return formatModel(session?.model)
    } catch (error) {
      deps.logger.warn(`读取会话 ${sessionID} 失败：${errorText(error)}`)
      return undefined
    }
  }

  const sendPrompt = async (sessionID: string, rule: Rule): Promise<void> => {
    try {
      await deps.prompt({ sessionID, text: rule.prompt })
      deps.logger.debug(`已向会话 ${sessionID} 发送续写`)
    } catch (error) {
      deps.logger.warn(`向会话 ${sessionID} 发送续写失败：${errorText(error)}`)
    }
  }

  return {
    start,
    /** 测试用：处理完后这些表应该空，避免按事件无限增长。 */
    retained(): RetainedEntries {
      return {
        tails: tails.size,
        cancels: cancelCounts.size,
        counts: state.size(),
        pending: pending.size,
        progress: progress.size,
      }
    },
  }
}

function cutoffOf(
  messages: readonly TranscriptMessage[],
  assistantID: string | undefined,
  eventCreated: number | undefined,
): number {
  const assistant = assistantID ? findById(messages, assistantID) : undefined
  if (assistant?.time?.completed !== undefined) return assistant.time.completed
  if (assistant?.time?.created !== undefined) return assistant.time.created
  if (eventCreated !== undefined) return eventCreated
  return Number.POSITIVE_INFINITY
}

function hasUserMessageAfter(messages: readonly TranscriptMessage[], cutoff: number): boolean {
  return messages.some((message) => message.type === "user" && (message.time?.created ?? 0) > cutoff)
}

function findById(messages: readonly TranscriptMessage[], id: string): TranscriptMessage | undefined {
  return messages.find((message) => message.id === id)
}

function readError(event: ObservedEvent): { type: string; message: string } | undefined {
  const error = event.data?.error
  if (!error?.type || typeof error.message !== "string") return undefined
  return { type: error.type, message: error.message }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
