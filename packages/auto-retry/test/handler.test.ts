import { describe, expect, it } from "vitest"
import type { Rule } from "../src/config/schema"
import { createHandler, type ObservedEvent, type TranscriptMessage } from "../src/handler"
import type { Logger } from "../src/utils/logger"

const MODEL = { providerID: "google", id: "gemini-3-pro" }
const BLOCKED = "Provider blocked the response"

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    models: ["google/*"],
    errors: [BLOCKED],
    prompt: "继续",
    maxRetries: 3,
    delayMs: 0,
    resetAfterToolCalls: 10,
    resetAfterMs: 120_000,
    ...overrides,
  }
}

function assistant(id: string, created = 100, model: TranscriptMessage["model"] | null = MODEL): TranscriptMessage {
  return {
    id,
    type: "assistant",
    time: { created, completed: created + 10 },
    // null 表示消息上确实没有模型；不能用 undefined，否则会落到默认参数。
    ...(model ? { model } : {}),
    error: { type: "provider.content-filter", message: BLOCKED },
    finish: "content-filter",
  }
}

function userMessage(id: string, created: number): TranscriptMessage {
  return { id, type: "user", time: { created }, text: "用户" }
}

function stepFailed(sessionID: string, assistantMessageID: string): ObservedEvent {
  return {
    type: "session.step.failed",
    created: 1_000,
    data: {
      sessionID,
      assistantMessageID,
      error: { type: "provider.content-filter", message: BLOCKED },
      finish: "content-filter",
    },
  }
}

function executionFailed(sessionID: string): ObservedEvent {
  return {
    type: "session.execution.failed",
    created: 1_001,
    data: {
      sessionID,
      error: { type: "provider.content-filter", message: BLOCKED },
    },
  }
}

function stepEnded(sessionID: string, finish: string): ObservedEvent {
  return {
    type: "session.step.ended",
    created: 1_100,
    data: { sessionID, assistantMessageID: "msg_ok", finish },
  }
}

function toolCalled(sessionID: string, id: string): ObservedEvent {
  return {
    type: "session.tool.called",
    data: { sessionID, id },
  }
}

function stepStarted(sessionID: string, assistantMessageID: string): ObservedEvent {
  return {
    type: "session.step.started",
    created: 900,
    data: { sessionID, assistantMessageID, model: MODEL },
  }
}

function interrupted(sessionID: string): ObservedEvent {
  return {
    type: "session.execution.interrupted",
    created: 1_200,
    data: { sessionID, reason: "user" },
  }
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {} }

async function* eventsOf(events: ObservedEvent[]): AsyncIterable<ObservedEvent> {
  for (const event of events) yield event
}

interface RunOptions {
  events: ObservedEvent[] | AsyncIterable<ObservedEvent>
  rules?: Rule[]
  messages?: TranscriptMessage[] | (() => Promise<TranscriptMessage[]> | TranscriptMessage[])
  getSession?: (sessionID: string) => Promise<{ model?: TranscriptMessage["model"]; parentID?: string } | undefined>
  sleep?: (ms: number) => Promise<void>
  logger?: Logger
  now?: () => number
}

async function run(options: RunOptions) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const notices: string[] = []
  const order: string[] = []
  const prompt = async (input: { sessionID: string; text: string }) => {
    order.push("prompt")
    prompts.push(input)
  }
  const listMessages = async () => {
    order.push("list")
    if (typeof options.messages === "function") return options.messages()
    return options.messages ?? []
  }
  const events = Array.isArray(options.events) ? eventsOf(options.events) : options.events
  const handler = createHandler({
    events,
    prompt,
    getSession: options.getSession ?? (async () => undefined),
    listMessages,
    notify: (message) => {
      notices.push(message)
    },
    config: { rules: options.rules ?? [rule()], warnings: [] },
    logger: options.logger ?? silentLogger,
    // 现有失败事件的 created 是 1000。启动时间取 0，避免被当成历史回放丢掉。
    now: options.now ?? (() => 0),
    sleep: async (ms) => {
      order.push(`sleep:${ms}`)
      await options.sleep?.(ms)
    },
  })
  await handler.start()

  return { prompts, notices, order, retained: () => handler.retained() }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function manualStream() {
  const buffer: ObservedEvent[] = []
  let ended = false
  let waiting: ((result: IteratorResult<ObservedEvent>) => void) | undefined

  return {
    push(event: ObservedEvent) {
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ value: event, done: false })
        return
      }
      buffer.push(event)
    },
    end() {
      ended = true
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ value: undefined, done: true })
      }
    },
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

describe("createHandler", () => {
  it("连发 step.failed 与 execution.failed 只发送一条继续", async () => {
    const { prompts } = await run({
      events: [stepFailed("ses_1", "msg_a"), executionFailed("ses_1")],
      messages: [assistant("msg_a")],
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("execution.failed 先到、step.failed 后到也只发送一条", async () => {
    const { prompts } = await run({
      events: [executionFailed("ses_1"), stepFailed("ses_1", "msg_a")],
      messages: [assistant("msg_a")],
      // execution.failed 没有助手消息 id，模型只能回退到会话。
      getSession: async () => ({ model: MODEL }),
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("发送前等待 delayMs，再复查消息", async () => {
    const { prompts, order } = await run({
      events: [stepFailed("ses_1", "msg_a")],
      rules: [rule({ delayMs: 2000, prompt: "继续" })],
      messages: [assistant("msg_a")],
    })

    expect(order).toEqual(["list", "sleep:2000", "list", "prompt"])
    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("连续失败超过 maxRetries 后停止，并且只提示一次", async () => {
    const { prompts, notices } = await run({
      // 两次失败之间要有新的 step.started，否则后者会被当成同一次失败的重复事件。
      events: [
        stepFailed("ses_1", "msg_1"),
        stepStarted("ses_1", "msg_2"),
        stepFailed("ses_1", "msg_2"),
        stepStarted("ses_1", "msg_3"),
        stepFailed("ses_1", "msg_3"),
        stepStarted("ses_1", "msg_4"),
        stepFailed("ses_1", "msg_4"),
      ],
      rules: [rule({ maxRetries: 2 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200), assistant("msg_3", 300), assistant("msg_4", 400)],
    })

    expect(prompts).toHaveLength(2)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("停止")
  })

  it("失败之间有正常完成的 step 时计数清零", async () => {
    const { prompts, notices } = await run({
      events: [stepFailed("ses_1", "msg_1"), stepEnded("ses_1", "stop"), stepFailed("ses_1", "msg_2")],
      rules: [rule({ maxRetries: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("finish 为 content-filter 的 step 不清零", async () => {
    const { prompts, notices } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        stepEnded("ses_1", "content-filter"),
        stepStarted("ses_1", "msg_2"),
        stepFailed("ses_1", "msg_2"),
      ],
      rules: [rule({ maxRetries: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("失败之后出现新的用户消息时跳过发送", async () => {
    const before = [userMessage("msg_old", 50), assistant("msg_a", 100)]
    const after = [...before, userMessage("msg_new", 1_500)]
    let reads = 0
    const { prompts } = await run({
      events: [stepFailed("ses_1", "msg_a")],
      messages: () => {
        reads += 1
        return reads === 1 ? before : after
      },
    })

    expect(prompts).toEqual([])
  })

  it("失败之前已经存在的用户消息不会阻止续写", async () => {
    const { prompts } = await run({
      events: [stepFailed("ses_1", "msg_a")],
      messages: [userMessage("msg_old", 50), assistant("msg_a", 100)],
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("step.failed 的 error.type 为 aborted 时不续写", async () => {
    const event: ObservedEvent = {
      type: "session.step.failed",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        error: { type: "aborted", message: "Step interrupted" },
      },
    }
    const { prompts, notices } = await run({
      events: [event],
      messages: [assistant("msg_a")],
      getSession: async () => ({ model: MODEL }),
    })

    expect(prompts).toEqual([])
    expect(notices).toEqual([])
  })

  it("等待期间收到用户中断则取消这次发送", async () => {
    const stream = manualStream()
    let releaseSleep = () => {}
    let markSleepEntered = () => {}
    const sleepEntered = new Promise<void>((resolve) => {
      markSleepEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_a")],
      notify: () => {},
      config: { rules: [rule({ delayMs: 2000 })], warnings: [] },
      logger: silentLogger,
      now: () => 0,
      sleep: async () => {
        markSleepEntered()
        await gate
      },
    }).start()

    stream.push(stepFailed("ses_1", "msg_a"))
    await sleepEntered
    stream.push(interrupted("ses_1"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseSleep()
    stream.end()
    await running

    expect(prompts).toEqual([])
  })

  it("没有规则命中时不发送，也不调用 prompt", async () => {
    let prompted = false
    await createHandler({
      events: eventsOf([stepFailed("ses_1", "msg_a")]),
      prompt: async () => {
        prompted = true
        throw new Error("不应调用 prompt")
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a", 100, { providerID: "anthropic", id: "claude" })],
      notify: () => {},
      config: { rules: [rule({ models: ["google/*"] })], warnings: [] },
      logger: silentLogger,
      now: () => 0,
    }).start()

    expect(prompted).toBe(false)
  })

  it("没有规则时完全不读取消息也不发送", async () => {
    let listed = false
    let prompted = false
    await createHandler({
      events: eventsOf([stepFailed("ses_1", "msg_a")]),
      prompt: async () => {
        prompted = true
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => {
        listed = true
        return [assistant("msg_a")]
      },
      notify: () => {},
      config: { rules: [], warnings: [] },
      logger: silentLogger,
      now: () => 0,
    }).start()

    expect(listed).toBe(false)
    expect(prompted).toBe(false)
  })

  it("不是 provider.content-filter 的失败不触发", async () => {
    const event: ObservedEvent = {
      type: "session.step.failed",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        error: { type: "provider.unknown", message: BLOCKED },
      },
    }
    const { prompts } = await run({ events: [event], messages: [assistant("msg_a")] })

    expect(prompts).toEqual([])
  })

  it("消息上没有模型时回退到会话模型", async () => {
    const { prompts } = await run({
      events: [stepFailed("ses_1", "msg_a")],
      messages: [assistant("msg_a", 100, null)],
      getSession: async () => ({ model: MODEL }),
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("消息和会话都没有模型时视为不命中", async () => {
    const { prompts } = await run({
      events: [stepFailed("ses_1", "msg_a")],
      messages: [assistant("msg_a", 100, null)],
      getSession: async () => ({}),
    })

    expect(prompts).toEqual([])
  })

  it("会话模型回退时，parentID 不会阻止续写", async () => {
    const { prompts } = await run({
      events: [stepFailed("ses_child", "msg_a")],
      messages: [assistant("msg_a", 100, null)],
      getSession: async () => ({ parentID: "ses_parent", model: MODEL }),
    })

    expect(prompts).toEqual([{ sessionID: "ses_child", text: "继续" }])
  })

  it("finish 为 error 的 step 不清零，随后的失败仍会熔断", async () => {
    const { prompts, notices } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        stepEnded("ses_1", "error"),
        // step.started 只解开同一次失败的闩，本身不是进展。
        stepStarted("ses_1", "msg_2"),
        stepFailed("ses_1", "msg_2"),
      ],
      rules: [rule({ maxRetries: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("execution.failed 先到且消息里还没有失败助手时，随后的 step.failed 不再发送", async () => {
    const { prompts } = await run({
      events: [executionFailed("ses_1"), stepFailed("ses_1", "msg_a")],
      messages: [],
      getSession: async () => ({ model: MODEL }),
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("新的 step 开始后再次失败会累加并可以再次触发", async () => {
    const { prompts } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        stepStarted("ses_1", "msg_2"),
        stepFailed("ses_1", "msg_2"),
      ],
      rules: [rule({ maxRetries: 3 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toEqual([
      { sessionID: "ses_1", text: "继续" },
      { sessionID: "ses_1", text: "继续" },
    ])
  })

  it("不采用 step.started 上的模型，消息和会话都没有则不命中", async () => {
    const { prompts } = await run({
      events: [stepStarted("ses_1", "msg_a"), stepFailed("ses_1", "msg_a")],
      messages: [assistant("msg_a", 100, null)],
      getSession: async () => ({}),
    })

    expect(prompts).toEqual([])
  })

  it("失败事件入队后、任务执行前的中断会取消发送", async () => {
    const stream = manualStream()
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_a")],
      notify: () => {},
      config: { rules: [rule({ delayMs: 0 })], warnings: [] },
      logger: silentLogger,
      now: () => 0,
    }).start()

    await new Promise((resolve) => setTimeout(resolve, 0))
    stream.push(stepFailed("ses_1", "msg_a"))
    stream.push(interrupted("ses_1"))
    stream.end()
    await running

    expect(prompts).toEqual([])
  })

  it("两个会话的事件交错时计数互不影响", async () => {
    const { prompts, notices } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        stepFailed("ses_2", "msg_2"),
        stepStarted("ses_1", "msg_3"),
        stepFailed("ses_1", "msg_3"),
        stepStarted("ses_2", "msg_4"),
        stepFailed("ses_2", "msg_4"),
      ],
      rules: [rule({ maxRetries: 1 })],
      messages: [
        assistant("msg_1", 100),
        assistant("msg_2", 200),
        assistant("msg_3", 300),
        assistant("msg_4", 400),
      ],
    })

    expect(prompts).toEqual([
      { sessionID: "ses_1", text: "继续" },
      { sessionID: "ses_2", text: "继续" },
    ])
    expect(notices).toHaveLength(2)
  })

  it("一轮处理结束后不留下会话条目", async () => {
    const handler = createHandler({
      events: eventsOf([stepFailed("ses_1", "msg_1"), stepEnded("ses_1", "stop")]),
      prompt: async () => {},
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_1")],
      notify: () => {},
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
      now: () => 0,
    })

    await handler.start()

    expect(handler.retained()).toEqual({ tails: 0, cancels: 0, counts: 0, pending: 0, progress: 0, gone: 0, stopped: 0, reserved: 0 })
  })

  it("每次只走三步工具调用时，连续失败会累加到熔断", async () => {
    const events: ObservedEvent[] = []
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (attempt > 1) events.push(stepStarted("ses_1", `msg_${attempt}`))
      for (let index = 0; index < 3; index += 1) {
        events.push(toolCalled("ses_1", `a${attempt}_${index}`))
      }
      events.push(stepFailed("ses_1", `msg_${attempt}`))
    }
    const { prompts, notices } = await run({
      events,
      rules: [rule({ maxRetries: 5 })],
      messages: [1, 2, 3, 4, 5, 6].map((n) => assistant(`msg_${n}`, n * 100)),
    })

    expect(prompts).toHaveLength(5)
    expect(notices).toHaveLength(1)
  })

  it("失败前凑够 resetAfterToolCalls 次工具调用则计数清零重算", async () => {
    const events: ObservedEvent[] = [stepFailed("ses_1", "msg_1"), stepStarted("ses_1", "msg_2")]
    for (let index = 0; index < 10; index += 1) events.push(toolCalled("ses_1", `t_${index}`))
    events.push(stepFailed("ses_1", "msg_2"))
    const { prompts, notices } = await run({
      events,
      rules: [rule({ maxRetries: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("规则把工具调用阈值改成 3 时，三次调用就清零", async () => {
    const events: ObservedEvent[] = [stepFailed("ses_1", "msg_1"), stepStarted("ses_1", "msg_2")]
    for (let index = 0; index < 3; index += 1) events.push(toolCalled("ses_1", `t_${index}`))
    events.push(stepFailed("ses_1", "msg_2"))
    const { prompts, notices } = await run({
      events,
      rules: [rule({ maxRetries: 1, resetAfterToolCalls: 3 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("用户离开很久但这一步实际运行很短时，不按墙钟清零", async () => {
    let t = 0
    const stream = manualStream()
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const running = createHandler({
      events: stream,
      now: () => t,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterMs: 1_000 })], warnings: [] },
      logger: silentLogger,
    }).start()
    await settle()
    t = 0
    stream.push(stepStarted("ses_1", "msg_1"))
    await settle()
    t = 20
    stream.push(stepFailed("ses_1", "msg_1"))
    await settle()
    t = 100_000
    stream.push(stepStarted("ses_1", "msg_2"))
    await settle()
    t = 100_020
    stream.push(stepFailed("ses_1", "msg_2"))
    await settle()
    stream.end()
    await running

    expect(prompts).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it.each([
    {
      name: "非内容拦截的 step.failed",
      terminate: (): ObservedEvent => ({
        type: "session.step.failed",
        created: 2_000,
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_2",
          error: { type: "aborted", message: "Step interrupted" },
        },
      }),
    },
    {
      name: "session.execution.interrupted",
      terminate: (): ObservedEvent => interrupted("ses_1"),
    },
    {
      name: "finish 为 unknown 的 step.ended",
      terminate: (): ObservedEvent => stepEnded("ses_1", "unknown"),
    },
  ])("$name 之后的空闲不计入运行时长", async ({ terminate }) => {
    let t = 0
    const stream = manualStream()
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const running = createHandler({
      events: stream,
      now: () => t,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [
        assistant("msg_1", 100),
        assistant("msg_2", 200),
        assistant("msg_3", 300),
      ],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterMs: 1_000 })], warnings: [] },
      logger: silentLogger,
    }).start()
    await settle()
    t = 0
    stream.push(stepStarted("ses_1", "msg_1"))
    await settle()
    t = 20
    stream.push(stepFailed("ses_1", "msg_1"))
    await settle()
    t = 20
    stream.push(stepStarted("ses_1", "msg_2"))
    await settle()
    t = 40
    stream.push(terminate())
    await settle()
    t = 50_000
    stream.push(stepStarted("ses_1", "msg_3"))
    await settle()
    t = 50_020
    stream.push(stepFailed("ses_1", "msg_3"))
    await settle()
    stream.end()
    await running

    expect(prompts).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("累计运行时长达到 resetAfterMs 后失败则计数清零重算", async () => {
    let t = 0
    const stream = manualStream()
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const running = createHandler({
      events: stream,
      now: () => t,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200), assistant("msg_3", 300)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterMs: 1_000 })], warnings: [] },
      logger: silentLogger,
    }).start()
    await settle()
    t = 0
    stream.push(stepStarted("ses_1", "msg_1"))
    await settle()
    t = 30
    stream.push(stepFailed("ses_1", "msg_1"))
    await settle()
    t = 30
    stream.push(stepStarted("ses_1", "msg_2"))
    await settle()
    t = 1_200
    stream.push(stepEnded("ses_1", "tool-calls"))
    await settle()
    t = 1_200
    stream.push(stepStarted("ses_1", "msg_3"))
    await settle()
    t = 1_500
    stream.push(stepFailed("ses_1", "msg_3"))
    await settle()
    stream.end()
    await running

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("stop 前后各 3 次工具调用不会凑满阈值 4", async () => {
    const stream = manualStream()
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const handler = createHandler({
      events: stream,
      now: () => 0,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterToolCalls: 4 })], warnings: [] },
      logger: silentLogger,
    })
    const running = handler.start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_1"))
    await settle()
    stream.push(stepStarted("ses_1", "msg_2"))
    for (let index = 0; index < 3; index += 1) stream.push(toolCalled("ses_1", `before_${index}`))
    await settle()
    stream.push(stepEnded("ses_1", "stop"))
    await settle()
    // stop 必须丢掉此前的推进量。删掉 progress.delete 时这里不是 0。
    expect(handler.retained().progress).toBe(0)
    for (let index = 0; index < 3; index += 1) stream.push(toolCalled("ses_1", `after_${index}`))
    stream.push(stepFailed("ses_1", "msg_2"))
    await settle()
    stream.end()
    await running

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("finish 为 tool-calls 的 step 既不清零也不算进工具调用数", async () => {
    const { prompts, notices } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        stepEnded("ses_1", "tool-calls"),
        stepFailed("ses_1", "msg_2"),
      ],
      rules: [rule({ maxRetries: 1, resetAfterToolCalls: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("启动前的失败事件是历史回放，不触发，也不占去重闩", async () => {
    const historical = stepFailed("ses_1", "msg_old")
    historical.created = 10
    const live = stepFailed("ses_1", "msg_new")
    live.created = 2_000_000
    const { prompts } = await run({
      events: [historical, stepStarted("ses_1", "msg_new"), live],
      now: () => 1_000_000,
      messages: [assistant("msg_old", 100), assistant("msg_new", 200)],
    })

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("前一个任务结束时不会清掉后面任务还要看的中断标记", async () => {
    const stream = manualStream()
    let releaseSleep = () => {}
    let markSleepEntered = () => {}
    const sleepEntered = new Promise<void>((resolve) => {
      markSleepEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      now: () => 0,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200)],
      notify: () => {},
      config: { rules: [rule({ delayMs: 2_000, maxRetries: 5 })], warnings: [] },
      logger: silentLogger,
      sleep: async () => {
        markSleepEntered()
        await gate
      },
    }).start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_1"))
    await sleepEntered
    stream.push(stepEnded("ses_1", "stop"))
    stream.push(stepFailed("ses_1", "msg_2"))
    stream.push(interrupted("ses_1"))
    await settle()
    releaseSleep()
    stream.end()
    await running

    expect(prompts).toEqual([])
  })

  it("熔断放弃后清掉该会话的计数、闩和推进量", async () => {
    const { notices, retained } = await run({
      events: [stepFailed("ses_1", "msg_1"), stepStarted("ses_1", "msg_2"), stepFailed("ses_1", "msg_2")],
      rules: [rule({ maxRetries: 1 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(notices).toHaveLength(1)
    // stopped 要留着，挡住同一轮后续失败，直到 stop 或足够推进量。
    expect(retained()).toEqual({ tails: 0, cancels: 0, counts: 0, pending: 0, progress: 0, gone: 0, stopped: 1, reserved: 0 })
  })

  it("中断取消发送后清掉该会话的内部状态", async () => {
    const stream = manualStream()
    let releaseSleep = () => {}
    let markSleepEntered = () => {}
    const sleepEntered = new Promise<void>((resolve) => {
      markSleepEntered = resolve
    })
    const handler = createHandler({
      events: stream,
      now: () => 0,
      prompt: async () => {
        throw new Error("不应发送")
      },
      getSession: async () => undefined,
      listMessages: async () => [assistant("msg_a")],
      notify: () => {},
      config: { rules: [rule({ delayMs: 2_000 })], warnings: [] },
      logger: silentLogger,
      sleep: async () => {
        markSleepEntered()
        await gate
      },
    })
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    const running = handler.start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_a"))
    await sleepEntered
    stream.push(interrupted("ses_1"))
    await settle()
    releaseSleep()
    stream.end()
    await running

    expect(handler.retained()).toEqual({ tails: 0, cancels: 0, counts: 0, pending: 0, progress: 0, gone: 0, stopped: 0, reserved: 0 })
  })

  it("session.deleted 清掉该会话的全部状态", async () => {
    const { prompts, retained } = await run({
      events: [
        stepFailed("ses_1", "msg_1"),
        { type: "session.deleted", data: { sessionID: "ses_1" } },
      ],
      messages: [assistant("msg_1")],
    })

    expect(prompts).toEqual([])
    // gone 留着，避免删除之后的查询把计数写回去。
    expect(retained()).toEqual({ tails: 0, cancels: 0, counts: 0, pending: 0, progress: 0, gone: 1, stopped: 0, reserved: 0 })
  })

  it("工具 id 超过 1000 个时丢掉最旧的，旧 id 可以再次计入", async () => {
    const events: ObservedEvent[] = [stepFailed("ses_1", "msg_1"), stepStarted("ses_1", "msg_2")]
    for (let index = 0; index < 1001; index += 1) events.push(toolCalled("ses_1", `t_${index}`))
    events.push(toolCalled("ses_1", "t_0"))
    events.push(stepFailed("ses_1", "msg_2"))
    const { prompts, notices } = await run({
      events,
      rules: [rule({ maxRetries: 1, resetAfterToolCalls: 1002 })],
      messages: [assistant("msg_1", 100), assistant("msg_2", 200)],
    })

    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  const home = { directory: "/proj", workspaceID: "ws-a" }
  const otherWorkspace = { directory: "/proj", workspaceID: "ws-b" }
  const otherDirectory = { directory: "/other", workspaceID: "ws-a" }

  function moved(sessionID: string, location: { directory: string; workspaceID?: string }): ObservedEvent {
    return { type: "session.moved", data: { sessionID, location } }
  }

  it("多个 location 的 handler 收到同一次失败时，只有 owner 发送一条", async () => {
    const place = home
    const open = (owner: { directory: string; workspaceID?: string }) => {
      const stream = manualStream()
      const prompts: Array<{ sessionID: string; text: string }> = []
      const running = createHandler({
        events: stream,
        now: () => 0,
        owner,
        readOwner: async () => place,
        prompt: async (input) => {
          prompts.push(input)
        },
        getSession: async () => ({ model: MODEL }),
        listMessages: async () => [assistant("msg_a")],
        notify: () => {},
        config: { rules: [rule()], warnings: [] },
        logger: silentLogger,
      }).start()
      return { stream, prompts, running }
    }

    const owned = open(home)
    const sameDir = open(otherWorkspace)
    const otherDir = open(otherDirectory)
    await settle()
    for (const handler of [owned, sameDir, otherDir]) {
      handler.stream.push(stepFailed("ses_1", "msg_a"))
    }
    await settle()
    for (const handler of [owned, sameDir, otherDir]) handler.stream.end()
    await Promise.all([owned.running, sameDir.running, otherDir.running])

    expect(owned.prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
    expect(sameDir.prompts).toEqual([])
    expect(otherDir.prompts).toEqual([])
  })

  it("主会话和子会话按各自 location 发送，parentID 不转发", async () => {
    const prompts: Array<{ sessionID: string; text: string }> = []
    await createHandler({
      events: eventsOf([stepFailed("ses_child", "msg_child"), stepFailed("ses_parent", "msg_parent")]),
      now: () => 0,
      owner: home,
      readOwner: async (sessionID) => (sessionID === "ses_child" ? home : otherWorkspace),
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async (sessionID) => ({
        model: MODEL,
        ...(sessionID === "ses_child" ? { parentID: "ses_parent" } : {}),
      }),
      listMessages: async () => [assistant("msg_child"), assistant("msg_parent", 200)],
      notify: () => {},
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
    }).start()

    expect(prompts).toEqual([{ sessionID: "ses_child", text: "继续" }])
  })

  it("无关会话的失败和中断不会留下 pending 或 cancel", async () => {
    const events: ObservedEvent[] = []
    for (let index = 0; index < 100; index += 1) {
      events.push(stepFailed(`ses_${index}`, `msg_${index}`))
      events.push(interrupted(`ses_${index}`))
    }
    const handler = createHandler({
      events: eventsOf(events),
      now: () => 0,
      owner: home,
      readOwner: async () => otherWorkspace,
      prompt: async () => {
        throw new Error("不应发送")
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [],
      notify: () => {},
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
    })
    await handler.start()
    expect(handler.retained()).toEqual({ tails: 0, cancels: 0, counts: 0, pending: 0, progress: 0, gone: 0, stopped: 0, reserved: 0 })
  })

  it("确认归属之前的工具调用仍会计入本 location 的清零", async () => {
    const events: ObservedEvent[] = [stepStarted("ses_1", "msg_1")]
    for (let index = 0; index < 3; index += 1) events.push(toolCalled("ses_1", `before_${index}`))
    events.push(stepFailed("ses_1", "msg_1"), stepStarted("ses_1", "msg_2"))
    for (let index = 0; index < 3; index += 1) events.push(toolCalled("ses_1", `after_${index}`))
    events.push(stepFailed("ses_1", "msg_2"))
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    await createHandler({
      events: eventsOf(events),
      now: () => 0,
      owner: home,
      readOwner: async () => home,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterToolCalls: 3 })], warnings: [] },
      logger: silentLogger,
    }).start()
    expect(prompts).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("owner 尚未返回时到达的工具不能把这次已结算的失败清零", async () => {
    const stream = manualStream()
    let reads = 0
    let release = () => {}
    let markEntered = () => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const running = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async () => {
        reads += 1
        if (reads < 3) return home
        markEntered()
        await gate
        return home
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_1", 100), assistant("msg_2", 200)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1, resetAfterToolCalls: 3 })], warnings: [] },
      logger: silentLogger,
    }).start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_1"))
    await settle()
    stream.push(stepStarted("ses_1", "msg_2"))
    stream.push(stepFailed("ses_1", "msg_2"))
    await entered
    for (let index = 0; index < 3; index += 1) stream.push(toolCalled("ses_1", `late_${index}`))
    await settle()
    release()
    await settle()
    stream.end()
    await running

    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
    expect(notices).toHaveLength(1)
  })

  it("step.started 不查 owner；查询期间的删除、迁移、中断不会复活状态", async () => {
    let reads = 0
    const startedOnly = await runOwned(home, async () => {
      reads += 1
      return home
    }, [stepStarted("ses_1", "msg_a")])
    expect(reads).toBe(0)
    expect(startedOnly.prompts).toEqual([])

    const deleted = await releaseDuringFirstOwner((stream) => {
      stream.push({ type: "session.deleted", data: { sessionID: "ses_1" } })
    })
    const movedAway = await releaseDuringFirstOwner((stream) => {
      stream.push(moved("ses_1", otherWorkspace))
    })
    const stopped = await releaseDuringFirstOwner((stream) => {
      stream.push(interrupted("ses_1"))
    })
    expect(deleted.prompts).toEqual([])
    expect(deleted.notices).toEqual([])
    expect(deleted.retained).toMatchObject({ counts: 0, pending: 0, progress: 0, cancels: 0 })
    expect(movedAway.prompts).toEqual([])
    expect(movedAway.notices).toEqual([])
    expect(movedAway.retained).toMatchObject({ counts: 0, pending: 0, progress: 0, cancels: 0 })
    expect(stopped.prompts).toEqual([])
    expect(stopped.notices).toEqual([])
    expect(stopped.retained).toMatchObject({ counts: 0, pending: 0, progress: 0, cancels: 0 })
  })

  it("推进量会话超过容量后，新会话失败关闭且不重置已有计数", async () => {
    const events: ObservedEvent[] = []
    for (let index = 0; index < 1000; index += 1) {
      events.push(toolCalled(`pad_${index}`, `t_${index}`))
    }
    events.push(toolCalled("overflow", "too_many"))
    events.push(stepFailed("overflow", "msg_over"))
    events.push(stepFailed("pad_0", "msg_pad"))
    const prompts: Array<{ sessionID: string; text: string }> = []
    const handler = createHandler({
      events: eventsOf(events),
      now: () => 0,
      owner: home,
      readOwner: async (sessionID) => (sessionID === "overflow" ? otherWorkspace : home),
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_over"), assistant("msg_pad", 200)],
      notify: () => {},
      config: { rules: [rule({ maxRetries: 1 })], warnings: [] },
      logger: silentLogger,
    })
    await handler.start()
    expect(prompts.map((item) => item.sessionID)).toEqual(["pad_0"])
    expect(handler.retained().progress).toBeLessThanOrEqual(1000)
  })

  it("1200 个挂起失败不超过容量，释放后新会话可以进入", async () => {
    const stream = manualStream()
    let reads = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let opened = false
    const prompts: Array<{ sessionID: string; text: string }> = []
    const handler = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async (sessionID) => {
        if (sessionID === "fresh") {
          opened = true
          return home
        }
        reads += 1
        await gate
        return otherWorkspace
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_fresh")],
      notify: () => {},
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
    })
    const running = handler.start()
    await settle()
    for (let index = 0; index < 1200; index += 1) stream.push(stepFailed(`flood_${index}`, `msg_${index}`))
    await settle()

    expect(reads).toBe(1000)
    expect(handler.retained().pending).toBe(1000)
    expect(handler.retained().tails).toBe(1000)
    expect(handler.retained().progress).toBe(0)
    expect(handler.retained().reserved).toBe(1000)
    expect(prompts).toEqual([])

    release()
    await settle()
    expect(prompts).toEqual([])
    expect(handler.retained()).toMatchObject({ pending: 0, tails: 0, counts: 0, cancels: 0, reserved: 0 })

    stream.push(stepFailed("fresh", "msg_fresh"))
    await settle()
    stream.end()
    await running

    expect(opened).toBe(true)
    expect(reads).toBe(1000)
    expect(prompts).toEqual([{ sessionID: "fresh", text: "继续" }])
  })

  it("容量占满时不会挤掉已有失败计数", async () => {
    const stream = manualStream()
    let reads = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const handler = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async (sessionID) => {
        if (sessionID === "keep") return home
        reads += 1
        await gate
        return otherWorkspace
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_keep", 100), assistant("msg_next", 200)],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule({ maxRetries: 1 })], warnings: [] },
      logger: silentLogger,
    })
    const running = handler.start()
    await settle()
    stream.push(stepFailed("keep", "msg_keep"))
    await settle()
    expect(prompts).toEqual([{ sessionID: "keep", text: "继续" }])

    for (let index = 0; index < 1200; index += 1) stream.push(stepFailed(`flood_${index}`, "msg_flood"))
    await settle()
    expect(reads).toBeLessThanOrEqual(1000)
    expect(handler.retained().pending).toBeLessThanOrEqual(1000)
    expect(handler.retained().tails).toBeLessThanOrEqual(1000)
    expect(prompts).toEqual([{ sessionID: "keep", text: "继续" }])

    release()
    await settle()
    stream.push(stepStarted("keep", "msg_next"))
    stream.push(stepFailed("keep", "msg_next"))
    await settle()
    stream.end()
    await running

    expect(prompts).toEqual([{ sessionID: "keep", text: "继续" }])
    expect(notices).toHaveLength(1)
  })

  it("workspaceID 缺省只和缺省相等，不能匹配有 workspace 的会话", async () => {
    const { prompts } = await runOwned({ directory: "/proj" }, async () => ({ directory: "/proj", workspaceID: "ws-a" }))
    expect(prompts).toEqual([])
  })

  it("owner 缺失或读取抛错时不发送", async () => {
    const missing = await runOwned(home, async () => undefined)
    const thrown = await runOwned(home, async () => {
      throw new Error("get failed")
    })
    expect(missing.prompts).toEqual([])
    expect(thrown.prompts).toEqual([])
    expect(missing.notices).toEqual([])
    expect(thrown.notices).toEqual([])
  })

  it("delay 期间迁走后不发送，迁回来之后的新失败仍然发送", async () => {
    const stream = manualStream()
    let place: { directory: string; workspaceID?: string } = home
    let releaseSleep = () => {}
    let markSleepEntered = () => {}
    const sleepEntered = new Promise<void>((resolve) => {
      markSleepEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async () => place,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a"), assistant("msg_b", 200)],
      notify: () => {},
      config: { rules: [rule({ delayMs: 2_000 })], warnings: [] },
      logger: silentLogger,
      sleep: async () => {
        markSleepEntered()
        await gate
      },
    }).start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_a"))
    await sleepEntered
    place = otherWorkspace
    stream.push(moved("ses_1", otherWorkspace))
    await settle()
    releaseSleep()
    await settle()
    expect(prompts).toEqual([])

    place = home
    stream.push(stepStarted("ses_1", "msg_b"))
    stream.push(stepFailed("ses_1", "msg_b"))
    await settle()
    stream.end()
    await running
    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
  })

  it("最终 owner 查询期间的中断、删除或卸载都不再发送", async () => {
    const interrupted = await holdFinalOwner((stream) => {
      stream.push({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    })
    const deleted = await holdFinalOwner((stream) => {
      stream.push({ type: "session.deleted", data: { sessionID: "ses_1" } })
    })
    const unloaded = await holdFinalOwner((_stream, abort) => {
      abort.abort()
    })
    expect(interrupted).toEqual([])
    expect(deleted).toEqual([])
    expect(unloaded).toEqual([])
  })

  it("卸载能停掉还在 delay 里的待发任务", async () => {
    const abort = new AbortController()
    const stream = manualStream()
    let entered = false
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async () => home,
      signal: abort.signal,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a")],
      notify: () => {},
      config: { rules: [rule({ delayMs: 60_000 })], warnings: [] },
      logger: silentLogger,
      sleep: () =>
        new Promise(() => {
          entered = true
        }),
    }).start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_a"))
    await settle()
    expect(entered).toBe(true)
    abort.abort()
    stream.end()
    await running
    expect(prompts).toEqual([])
  })

  async function runOwned(
    owner: { directory: string; workspaceID?: string },
    readOwner: (sessionID: string) => Promise<{ directory: string; workspaceID?: string } | undefined>,
    events: ObservedEvent[] = [stepFailed("ses_1", "msg_a")],
  ) {
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    await createHandler({
      events: eventsOf(events),
      now: () => 0,
      owner,
      readOwner,
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a")],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
    }).start()
    return { prompts, notices }
  }

  async function releaseDuringFirstOwner(during: (stream: ReturnType<typeof manualStream>) => void) {
    const stream = manualStream()
    let release = () => {}
    let markEntered = () => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const notices: string[] = []
    const handler = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      readOwner: async () => {
        markEntered()
        await gate
        return home
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a")],
      notify: (message) => {
        notices.push(message)
      },
      config: { rules: [rule()], warnings: [] },
      logger: silentLogger,
    })
    const running = handler.start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_a"))
    await entered
    during(stream)
    await settle()
    release()
    await settle()
    stream.end()
    await running
    return { prompts, notices, retained: handler.retained() }
  }

  async function holdFinalOwner(
    during: (stream: ReturnType<typeof manualStream>, abort: AbortController) => void,
  ) {
    const abort = new AbortController()
    const stream = manualStream()
    let reads = 0
    let release = () => {}
    let markEntered = () => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: Array<{ sessionID: string; text: string }> = []
    const running = createHandler({
      events: stream,
      now: () => 0,
      owner: home,
      signal: abort.signal,
      readOwner: async () => {
        reads += 1
        if (reads === 1) return home
        markEntered()
        await gate
        return home
      },
      prompt: async (input) => {
        prompts.push(input)
      },
      getSession: async () => ({ model: MODEL }),
      listMessages: async () => [assistant("msg_a")],
      notify: () => {},
      config: { rules: [rule({ delayMs: 0 })], warnings: [] },
      logger: silentLogger,
    }).start()
    await settle()
    stream.push(stepFailed("ses_1", "msg_a"))
    await entered
    during(stream, abort)
    await settle()
    release()
    await settle()
    stream.end()
    await running
    return prompts
  }
})
