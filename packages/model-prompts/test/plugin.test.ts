import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Plugin } from "@opencode/plugin"
import DefaultPlugin, { ModelPromptsPlugin } from "../src/index"
import { fixture } from "./helpers"

type Fixture = Awaited<ReturnType<typeof fixture>>
type ContextInput = {
  model: { providerID: string; id: string; variant?: string }
  agent?: string
  tools: Record<string, unknown>
  system: Array<{ type: "text"; text: string }>
}

let env: Fixture
beforeEach(async () => { env = await fixture() })
afterEach(async () => { await env.cleanup(); vi.restoreAllMocks() })

async function setup(options: Record<string, unknown>, agent?: {
  get?: (input: { agentID: string }) => Promise<{ data?: { id?: string; name?: string } }>
  list?: () => Promise<{ data: Array<{ id: string; name: string }> }>
}) {
  let callback: ((input: ContextInput) => Promise<void>) | undefined
  const hook = vi.fn(async (_name: string, fn: (input: ContextInput) => Promise<void>) => {
    callback = fn
  })
  await ModelPromptsPlugin.setup({
    location: { directory: env.project },
    options,
    session: { hook },
    agent,
  } as unknown as Parameters<typeof ModelPromptsPlugin.setup>[0])
  const invoke = async (input: Partial<ContextInput> = {}) => {
    const state: ContextInput = {
      model: { providerID: "openai", id: "gpt-5" },
      agent: "any",
      tools: {},
      system: [],
      ...input,
    }
    expect(callback).toBeDefined()
    await callback!(state)
    return state.system.map((part) => part.text)
  }
  return { hook, invoke }
}

describe("OpenCode context 插件", () => {
  it("默认、具名及根入口是同一 Plugin.define 实例", async () => {
    const root = await import("../index")
    expect(DefaultPlugin).toBe(ModelPromptsPlugin)
    expect(root.default).toBe(ModelPromptsPlugin)
    expect(root.ModelPromptsPlugin).toBe(ModelPromptsPlugin)
    expect(ModelPromptsPlugin.id).toBe("opencode-model-prompts")
    expect(Plugin.define(ModelPromptsPlugin)).toBe(ModelPromptsPlugin)
  })
  it("context hook 注入全局文件；agents 缺省匹配所有代理", async () => {
    await env.write(path.join(env.global, "model-prompts.jsonc"), '{"models":{"openai/*":["a.md","b.md"]}}')
    await env.write(path.join(env.global, "model-prompts", "a.md"), "\uFEFF first \n")
    await env.write(path.join(env.global, "model-prompts", "b.md"), "second")
    const plugin = await setup({})
    expect(plugin.hook).toHaveBeenCalledWith("context", expect.any(Function))
    expect(await plugin.invoke({ agent: "reviewer" })).toEqual(["first", "second"])
  })
  it("代理 id/name 别名、excludeAgents 与 requireTools", async () => {
    await env.write(path.join(env.project, ".opencode", "model-prompts", "a.md"), "guard")
    const plugin = await setup({
      agents: ["orchestrator"],
      excludeAgents: ["blocked*"],
      requireTools: ["search"],
      models: { "openai/*": ["a.md"] },
    }, {
      get: async () => ({ data: { id: "orchestrator", name: "blocked alias" } }),
    })
    expect(await plugin.invoke({ tools: { search: true } })).toEqual([])
    const allowed = await setup({
      agents: ["orchestrator", "Display*"],
      models: { "openai/*": ["a.md"] },
    }, {
      get: async () => ({ data: { id: "orchestrator", name: "Display Name" } }),
    })
    expect(await allowed.invoke()).toEqual(["guard"])
    const tools = await setup({ models: { "openai/*": { prompts: ["a.md"], requireTools: ["search"] } } })
    expect(await tools.invoke()).toEqual([])
    expect(await tools.invoke({ tools: { search: true } })).toEqual(["guard"])
  })
  it("agent.get 失败回退 list，并以展示名称匹配", async () => {
    await env.write(path.join(env.project, ".opencode", "model-prompts", "a.md"), "alias")
    const plugin = await setup({ agents: ["Display*"], models: { "*": ["a.md"] } }, {
      get: async () => { throw Error("not found") },
      list: async () => ({ data: [{ id: "agent-id", name: "Display Name" }] }),
    })
    expect(await plugin.invoke({ agent: "agent-id" })).toEqual(["alias"])
  })
  it("重复调用与既有 system 包含提示词时不重复注入", async () => {
    await env.write(path.join(env.project, ".opencode", "model-prompts", "a.md"), "stable")
    const plugin = await setup({ models: { "*": ["a.md"] } })
    const system: ContextInput["system"] = []
    expect(await plugin.invoke({ system })).toEqual(["stable"])
    expect(await plugin.invoke({ system })).toEqual(["stable"])
    expect(await plugin.invoke({ system: [{ type: "text", text: "prefix stable suffix" }] })).toEqual(["prefix stable suffix"])
  })
  it("Markdown 和 JSONC 变更按 stat 热更新", async () => {
    const file = path.join(env.global, "model-prompts.jsonc")
    const first = path.join(env.global, "model-prompts", "a.md")
    await env.write(file, '{"models":{"*":["a.md"]}}')
    await env.write(first, "one")
    const plugin = await setup({})
    expect(await plugin.invoke()).toEqual(["one"])
    await env.write(first, "two revised")
    expect(await plugin.invoke()).toEqual(["two revised"])
    await env.write(path.join(env.global, "model-prompts", "b.md"), "three")
    await env.write(file, '{"models":{"*":["b.md"]}}')
    expect(await plugin.invoke()).toEqual(["three"])
  })
  it("项目本地文件新建后覆盖之前的全局回退文件", async () => {
    await env.write(path.join(env.project, ".opencode", "model-prompts.jsonc"), '{"models":{"*":["shared.md"]}}')
    await env.write(path.join(env.global, "model-prompts", "shared.md"), "global")
    const plugin = await setup({})
    expect(await plugin.invoke()).toEqual(["global"])
    await env.write(path.join(env.project, ".opencode", "model-prompts", "shared.md"), "local override")
    expect(await plugin.invoke()).toEqual(["local override"])
  })
  it("缺失提示词在 setup 告警，之后补齐可热更新且不会崩溃", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const file = path.join(env.project, ".opencode", "model-prompts", "missing.md")
    const plugin = await setup({ models: { "*": ["missing.md"] } })
    expect(warn).toHaveBeenCalled()
    expect(await plugin.invoke()).toEqual([])
    await fs.mkdir(path.dirname(file), { recursive: true })
    await env.write(file, "now present")
    expect(await plugin.invoke()).toEqual(["now present"])
  })
})
