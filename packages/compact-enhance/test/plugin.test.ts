import { describe, expect, it, vi } from "vitest"
import { CompactEnhancePlugin } from "../src/index"

type Context = Parameters<typeof CompactEnhancePlugin.setup>[0]
type CommandTransform = Parameters<Context["command"]["transform"]>[0]
type CommandEditor = Parameters<CommandTransform>[0]
type CommandDefinition = Parameters<CommandEditor["add"]>[0]
type CommandInvocation = Parameters<CommandDefinition["execute"]>[0]
type Compaction = (input: { sessionID: string; messages: unknown[] }) => Promise<void>

async function setup() {
  let runCompaction: Compaction | undefined
  const add = vi.fn<CommandEditor["add"]>()
  const transform = vi.fn(async (fn: CommandTransform) => {
    fn({ add })
    return { dispose: vi.fn(async () => {}) }
  })
  const compactSession = vi.fn(async (_input: Parameters<Context["session"]["compact"]>[0]) => {})
  const hook = vi.fn(async (_name: string, callback: Compaction) => {
    runCompaction = callback
  })

  await CompactEnhancePlugin.setup({
    command: { transform },
    session: { hook, compact: compactSession },
  } as unknown as Context)

  expect(hook).toHaveBeenCalledWith("compaction", expect.any(Function))
  const command = add.mock.calls[0]?.[0]
  const compaction = runCompaction
  if (!command || !compaction) throw new Error("插件没有注册所需的命令或钩子")

  return {
    add,
    compactSession,
    execute(text: string, sessionID = "session-1") {
      return command.execute({
        sessionID: sessionID as CommandInvocation["sessionID"],
        prompt: { text },
        delivery: "queue",
      })
    },
    async compact(sessionID = "session-1", messages: unknown[] = []) {
      await compaction({ sessionID, messages })
      return messages
    },
  }
}

describe("compact-enhance 服务端插件", () => {
  it("注册 compact-enhance 服务端命令", async () => {
    const plugin = await setup()

    expect(plugin.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: "compact-enhance",
      execute: expect.any(Function),
    }))
  })

  it("带参数的命令触发压缩，保留原消息且只注入一次 user 偏向指令", async () => {
    const plugin = await setup()
    const history = { role: "user", content: [{ type: "text", text: "原始消息" }] }

    await plugin.execute("保留构建失败的原因")
    expect(plugin.compactSession).toHaveBeenCalledExactlyOnceWith({ sessionID: "session-1" })
    expect(await plugin.compact("session-1", [history])).toEqual([
      history,
      {
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("保留构建失败的原因") }],
      },
    ])
    expect(await plugin.compact("session-1", [history])).toEqual([history])
  })

  it.each(["", " \n\t "])("空参数 %j 仍触发压缩，但不注入指令", async (text) => {
    const plugin = await setup()

    await plugin.execute(text)
    expect(plugin.compactSession).toHaveBeenCalledExactlyOnceWith({ sessionID: "session-1" })
    expect(await plugin.compact()).toEqual([])
  })

  it("无指令时不修改消息", async () => {
    const plugin = await setup()
    const messages = [{ role: "user", content: [{ type: "text", text: "原始消息" }] }]
    Object.freeze(messages)
    expect(await plugin.compact("session-1", messages)).toBe(messages)
  })

  it("去除指令首尾的空白，但保留内部空白", async () => {
    const plugin = await setup()
    await plugin.execute(" \n 保留细节\n  略去日志 \t\n")

    expect(await plugin.compact()).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: expect.stringMatching(/\n\n保留细节\n  略去日志$/u) }],
      },
    ])
  })

  it("会话和插件实例之间互不影响，同一会话使用最新指令", async () => {
    const plugin = await setup()
    const other = await setup()
    await plugin.execute("旧指令")
    await plugin.execute("新指令")

    expect(await plugin.compact("session-2")).toEqual([])
    expect(await other.compact("session-1")).toEqual([])
    expect(await plugin.compact()).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("新指令") }],
      },
    ])
  })
})
