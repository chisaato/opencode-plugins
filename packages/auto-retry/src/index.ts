import { DateTime, Effect, Stream } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { loadConfig } from "./config/loader"
import {
  createHandler,
  isTrustworthyLocation,
  type ObservedEvent,
  type SessionLocation,
  type TranscriptMessage,
} from "./handler"
import { createLogger } from "./utils/logger"

/**
 * 命中规则时，向失败会话发送一条可见的续写。
 *
 * 用公开的 Effect 插件 API。Promise 版 session.get 的 location 只有 directory，
 * Effect 版才保留 workspaceID。宿主会为每个 location 起一个插件实例，但
 * updateContext 丢掉 Location 后，这些实例仍会一起收到同一条全局失败事件。
 * 不能按 event.location 过滤，也不能做成进程内单例。每个实例只在
 * session.get 的 directory 和 workspaceID 都与自己相同时才计数、发送。
 *
 * 不挂 session.hook("retry")。内核 retry 不会替这个插件发出可见的「继续」。
 * 这里只处理规则命中的 provider.content-filter，并不是「所有内容拦截都不重试」。
 */
const AutoRetryPlugin = Plugin.define({
  id: "opencode-auto-retry",
  effect: (ctx) =>
    Effect.gen(function* () {
      const logger = createLogger()
      const owner = toLocation(ctx.location)
      const config = yield* Effect.promise(() => loadConfig({ projectDir: ctx.location.directory, logger }))
      if (config.rules.length === 0) return
      if (!owner) {
        logger.warn("插件 location 不可信，不续写")
        return
      }

      // session.get 的 Effect 带着宿主运行时。后面在 promise 回调里要用同一份 context 跑。
      const context = yield* Effect.context<never>()
      const abort = new AbortController()
      const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
        Effect.runPromiseWith(context)(effect, { signal: abort.signal })
      const queue = createEventQueue()
      const asSessionID = (sessionID: string) => sessionID as Parameters<typeof ctx.session.get>[0]["sessionID"]

      let handlerDone = Promise.resolve()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          abort.abort()
          queue.finish()
          await handlerDone
        }),
      )

      const handler = createHandler({
        events: queue,
        signal: abort.signal,
        owner,
        readOwner: async (sessionID) => {
          const session = await run(ctx.session.get({ sessionID: asSessionID(sessionID) }))
          return toLocation(session.location)
        },
        prompt: async (input) => {
          await run(
            ctx.session.prompt({
              sessionID: asSessionID(input.sessionID),
              text: input.text,
            }),
          )
        },
        getSession: async (sessionID) => {
          const session = await run(ctx.session.get({ sessionID: asSessionID(sessionID) }))
          return { model: session.model, parentID: session.parentID }
        },
        listMessages: async (sessionID) => {
          const messages = await run(ctx.session.context({ sessionID: asSessionID(sessionID) }))
          return mapMessages(messages)
        },
        notify: (message) => {
          logger.warn(message)
        },
        config,
        logger,
      })
      handlerDone = handler.start()

      // 订阅挂在宿主 Scope 上。本 effect 随即返回，避免宿主把加载当成一条永不结束的任务。
      // 关掉 Scope 时 fork 被中断，finalizer 再用 abort 停掉还在 await 的 session 查询。
      yield* Stream.runForEach(ctx.event.subscribe(), (event) =>
        Effect.sync(() => {
          queue.push(observe(event))
        }),
      ).pipe(Effect.forkScoped)
    }),
})

function mapMessages(messages: ReadonlyArray<{ readonly id: string; readonly type: string }>): TranscriptMessage[] {
  const mapped: TranscriptMessage[] = []
  for (const message of messages) {
    const next = mapMessage(message)
    if (next) mapped.push(next)
  }
  return mapped
}

function mapMessage(message: { readonly id: string; readonly type: string }): TranscriptMessage | undefined {
  if (typeof message.id !== "string" || typeof message.type !== "string") return undefined
  const result: TranscriptMessage = { id: message.id, type: message.type }
  if ("time" in message && message.time && typeof message.time === "object") {
    const created = "created" in message.time ? toMillis(message.time.created) : undefined
    const completed = "completed" in message.time ? toMillis(message.time.completed) : undefined
    if (created !== undefined) result.time = { created, ...(completed !== undefined ? { completed } : {}) }
  }
  if ("text" in message && typeof message.text === "string") result.text = message.text
  if ("finish" in message && typeof message.finish === "string") result.finish = message.finish
  if ("model" in message && message.model && typeof message.model === "object") {
    const model = message.model
    if (
      "providerID" in model &&
      typeof model.providerID === "string" &&
      "id" in model &&
      typeof model.id === "string"
    ) {
      result.model = {
        providerID: model.providerID,
        id: model.id,
        ...("variant" in model && typeof model.variant === "string" ? { variant: model.variant } : {}),
      }
    }
  }
  if ("error" in message && message.error && typeof message.error === "object") {
    const error = message.error
    if ("type" in error && typeof error.type === "string" && "message" in error && typeof error.message === "string") {
      result.error = { type: error.type, message: error.message }
    }
  }
  return result
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  return undefined
}

function toLocation(
  location: { readonly directory?: string; readonly workspaceID?: string } | undefined,
): SessionLocation | undefined {
  if (!isTrustworthyLocation(location)) return undefined
  if (location.workspaceID === undefined) return { directory: location.directory }
  return { directory: location.directory, workspaceID: location.workspaceID }
}

function observe(event: {
  readonly type: string
  readonly created?: number
  readonly data?: object
}): ObservedEvent {
  return {
    type: event.type,
    created: event.created,
    data: event.data ? pickData(event.data) : undefined,
  }
}

function pickData(data: object): NonNullable<ObservedEvent["data"]> {
  const result: NonNullable<ObservedEvent["data"]> = {}
  if ("sessionID" in data && typeof data.sessionID === "string") result.sessionID = data.sessionID
  if ("assistantMessageID" in data && typeof data.assistantMessageID === "string") {
    result.assistantMessageID = data.assistantMessageID
  }
  if ("finish" in data && typeof data.finish === "string") result.finish = data.finish
  if ("reason" in data && typeof data.reason === "string") result.reason = data.reason
  if ("id" in data && typeof data.id === "string") result.id = data.id
  if ("model" in data && data.model && typeof data.model === "object") {
    const model = data.model
    if (
      "providerID" in model &&
      typeof model.providerID === "string" &&
      "id" in model &&
      typeof model.id === "string"
    ) {
      result.model = {
        providerID: model.providerID,
        id: model.id,
        ...("variant" in model && typeof model.variant === "string" ? { variant: model.variant } : {}),
      }
    }
  }
  if ("error" in data && data.error && typeof data.error === "object") {
    const error = data.error
    if ("type" in error && typeof error.type === "string" && "message" in error && typeof error.message === "string") {
      result.error = { type: error.type, message: error.message }
    }
  }
  if ("location" in data && data.location && typeof data.location === "object") {
    const location = data.location
    const directory = "directory" in location && typeof location.directory === "string" ? location.directory : undefined
    const workspaceID =
      "workspaceID" in location && typeof location.workspaceID === "string" ? location.workspaceID : undefined
    const parsed = toLocation(workspaceID === undefined ? { directory } : { directory, workspaceID })
    if (parsed) result.location = parsed
  }
  return result
}

function createEventQueue(): AsyncIterable<ObservedEvent> & {
  push(event: ObservedEvent): void
  finish(): void
} {
  const buffer: ObservedEvent[] = []
  let ended = false
  let waiting: ((result: IteratorResult<ObservedEvent>) => void) | undefined

  const finish = () => {
    if (ended) return
    ended = true
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve({ value: undefined, done: true })
    }
  }

  return {
    push(event) {
      if (ended) return
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ value: event, done: false })
        return
      }
      buffer.push(event)
    },
    finish,
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = buffer.shift()
        if (next) {
          yield next
          continue
        }
        if (ended) return
        const result = await new Promise<IteratorResult<ObservedEvent>>((resolve) => {
          waiting = resolve
        })
        if (result.done) return
        yield result.value
      }
    },
  }
}

export default AutoRetryPlugin
