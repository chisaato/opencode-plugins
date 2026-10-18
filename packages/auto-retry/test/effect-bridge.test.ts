import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Exit, Queue, Scope, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import plugin from "../src/index"

const BLOCKED = "Provider blocked the response"
const MODEL = { providerID: "google", id: "gemini-3-pro" }

describe("Effect 插件桥接", () => {
  const temps: string[] = []
  let restoreEnv = () => {}

  afterEach(async () => {
    restoreEnv()
    restoreEnv = () => {}
    await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  it("session.get 的 workspaceID 会参与归属，同目录不同 workspace 不发送", async () => {
    const owned = await runFailure("ws-a", "ws-a")
    const other = await runFailure("ws-a", "ws-b")
    expect(owned.prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
    expect(owned.gets).toBeGreaterThan(0)
    expect(other.prompts).toEqual([])
    expect(other.gets).toBeGreaterThan(0)
  })

  it("没有事件时卸载会结束订阅，不等待下一条", async () => {
    let startedPull = false
    let released = false
    const events = Stream.callback<HostEvent>(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true
          }),
        )
        startedPull = true
        yield* Effect.never
      }),
    )
    const started = await startPlugin("ws-a", "ws-a", events)
    restoreEnv = started.restore
    const pulling = await Promise.race([
      waitFor(() => startedPull),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000)
      }),
    ])
    expect(pulling).toBe(true)
    const closed = await Promise.race([
      started.close().then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000)
      }),
    ])
    expect(closed).toBe(true)
    expect(released).toBe(true)
  })

  it("setup 返回后，外部 Scope 仍接收随后的失败", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<HostEvent>())
    const prompts: Array<{ sessionID: string; text: string }> = []
    const done = deferred<void>()
    const started = await startPlugin("ws-a", "ws-a", Stream.fromQueue(queue), {
      prompts,
      onPrompt: () => done.resolve(),
    })
    restoreEnv = started.restore
    await Effect.runPromise(
      Queue.offer(queue, {
        type: "session.step.failed",
        created: Date.now() + 1_000,
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_a",
          error: { type: "provider.content-filter", message: BLOCKED },
          finish: "content-filter",
        },
      }),
    )
    await done.promise
    expect(prompts).toEqual([{ sessionID: "ses_1", text: "继续" }])
    await started.close()
  })

  it("execution.failed 没有助手 id 时，DateTime 用户消息抢先则不发送", async () => {
    const prompts: Array<{ sessionID: string; text: string }> = []
    const eventCreated = Date.now() + 1_000
    const done = deferred<void>()
    const started = await startPlugin("ws-a", "ws-a", Stream.make({
      type: "session.execution.failed",
      created: eventCreated,
      data: {
        sessionID: "ses_1",
        error: { type: "provider.content-filter", message: BLOCKED },
      },
    }), {
      prompts,
      context: () =>
        Effect.succeed([
          {
            id: "msg_user",
            type: "user",
            text: "我来处理",
            time: { created: DateTime.makeUnsafe(eventCreated + 50) },
          },
        ]),
      onGet: () => done.resolve(),
    })
    restoreEnv = started.restore
    await done.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toEqual([])
    await started.close()
  })

  it("关闭 Scope 会中断挂起的 session 查询并很快返回", async () => {
    let ownerInterrupted = false
    const queue = await Effect.runPromise(Queue.unbounded<HostEvent>())
    const started = await startPlugin("ws-a", "ws-a", Stream.fromQueue(queue), {
      prompts: [],
      get: () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                ownerInterrupted = true
              }),
            )
            return yield* Effect.never
          }),
        ),
    })
    restoreEnv = started.restore
    await Effect.runPromise(
      Queue.offer(queue, {
        type: "session.step.failed",
        created: Date.now() + 1_000,
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_a",
          error: { type: "provider.content-filter", message: BLOCKED },
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const closed = await Promise.race([
      started.close().then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000)
      }),
    ])
    expect(closed).toBe(true)
    expect(ownerInterrupted).toBe(true)
  })

  async function runFailure(pluginWorkspace: string, sessionWorkspace: string) {
    const prompts: Array<{ sessionID: string; text: string }> = []
    let gets = 0
    const failure: HostEvent = {
      type: "session.step.failed",
      created: Date.now() + 1_000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        error: { type: "provider.content-filter", message: BLOCKED },
        finish: "content-filter",
      },
    }
    const done = deferred<void>()
    const events = Stream.make(failure)
    const started = await startPlugin(pluginWorkspace, sessionWorkspace, events, {
      prompts,
      onGet: () => {
        gets += 1
        if (gets === 1 && pluginWorkspace !== sessionWorkspace) done.resolve()
      },
      onPrompt: () => {
        done.resolve()
      },
    })
    await Promise.race([
      done.promise,
      new Promise((resolve) => {
        setTimeout(resolve, 1_000)
      }),
    ])
    restoreEnv = started.restore
    await started.close()
    return { prompts, gets }
  }

  async function startPlugin(
    pluginWorkspace: string,
    sessionWorkspace: string,
    events: Stream.Stream<HostEvent>,
    hooks?: {
      prompts: Array<{ sessionID: string; text: string }>
      onGet?: () => void
      onPrompt?: () => void
      get?: () => Effect.Effect<unknown, unknown, never>
      context?: () => Effect.Effect<ReadonlyArray<unknown>, unknown, never>
    },
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-retry-"))
    temps.push(root)
    const home = path.join(root, "home")
    const project = path.join(root, "project")
    await fs.mkdir(path.join(project, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(project, ".opencode", "auto-retry.json"),
      JSON.stringify({
        rules: [{ models: ["google/*"], errors: [BLOCKED], delayMs: 0 }],
      }),
    )
    const previousHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home

    const prompts = hooks?.prompts ?? []
    const ctx = {
      location: {
        directory: project,
        workspaceID: pluginWorkspace,
        project: { id: "proj", directory: project, canonical: project },
      },
      session: {
        get: () => {
          hooks?.onGet?.()
          if (hooks?.get) return hooks.get()
          return Effect.succeed({
            location: { directory: project, workspaceID: sessionWorkspace },
            model: MODEL,
          })
        },
        prompt: (input: { sessionID: string; text: string }) => {
          prompts.push({ sessionID: input.sessionID, text: input.text })
          hooks?.onPrompt?.()
          return Effect.succeed({ id: "inbox" })
        },
        context: () => {
          if (hooks?.context) return hooks.context()
          return Effect.succeed([
            {
              id: "msg_a",
              type: "assistant",
              model: MODEL,
              time: { created: DateTime.makeUnsafe(100), completed: DateTime.makeUnsafe(110) },
              error: { type: "provider.content-filter", message: BLOCKED },
            },
          ])
        },
      },
      event: {
        subscribe: () => events,
      },
    } as unknown as Parameters<typeof plugin.effect>[0]

    // 宿主自己持有 Scope：setup 返回后订阅还在，关掉 Scope 才卸载。
    const scope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(plugin.effect(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
    return {
      prompts,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      restore: () => {
        if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
        else process.env.OPENCODE_TEST_HOME = previousHome
      },
    }
  }
})

interface HostEvent {
  type: string
  created?: number
  data?: object
}

async function waitFor(ready: () => boolean): Promise<boolean> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 0))
  return true
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
