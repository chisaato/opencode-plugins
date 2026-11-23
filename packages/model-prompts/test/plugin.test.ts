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

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

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
  const run = async (state: ContextInput) => {
    expect(callback).toBeDefined()
    await callback!(state)
    return state.system.map((part) => part.text)
  }
  const invoke = (input: Partial<ContextInput> = {}) =>
    run({
      model: { providerID: "openai", id: "gpt-5" },
      agent: "any",
      tools: {},
      system: [],
      ...input,
    })
  return { hook, invoke, run }
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
  it("正文相同或互为子串不影响路径去重，同一输入重跑只保留本插件的每路径注入", async () => {
    await env.write(path.join(env.project, "a.md"), "prefix stable suffix")
    await env.write(path.join(env.project, "b.md"), "stable")
    await env.write(path.join(env.project, "c.md"), "stable")
    const plugin = await setup({ configPath: false, models: { "*": ["./a.md", "./b.md", "./c.md", "./nested/../b.md"] } })
    const external = { type: "text", text: "prefix stable suffix" } as const
    const input: ContextInput = { model: { providerID: "openai", id: "gpt-5" }, tools: {}, system: [external] }
    const expected = ["prefix stable suffix", "prefix stable suffix", "stable", "stable"]
    const first = await plugin.run(input)
    const second = await plugin.run(input)
    expect(first).toEqual(expected)
    expect(second).toEqual(expected)
    expect(input.system[0]).toBe(external)
    await env.write(path.join(env.project, "b.md"), "new prompt")
    await fs.unlink(path.join(env.project, "c.md"))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await plugin.run(input)).toEqual(["prefix stable suffix", "prefix stable suffix", "new prompt"])
    expect(input.system[0]).toBe(external)
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
  it.each(["Markdown", "JSONC"])("%s 在读取后、记录指纹前保存，不会把旧内容当作新版本", async (kind) => {
    const config = path.join(env.project, "model-prompts.jsonc")
    const first = path.join(env.project, "a.md")
    await env.write(config, '{"models":{"*":["./a.md"]}}')
    await env.write(first, "old")
    await env.write(path.join(env.project, "b.md"), "new from config")
    const target = kind === "Markdown" ? first : config
    const next = kind === "Markdown" ? "new prompt content" : '{"models":{"*":["./b.md"]}}'
    const readFile = fs.readFile
    let saved = false
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const contents = await readFile(...args)
      if (args[0] === target && !saved) {
        saved = true
        await env.write(target, next)
      }
      return contents
    })
    const plugin = await setup({ configPath: config })
    const outputs = [await plugin.invoke(), await plugin.invoke()]
    const expected = kind === "Markdown" ? next : "new from config"
    expect(saved).toBe(true)
    expect(outputs).toEqual([[expected], [expected]])
  })
  it("并发 context 共用一次刷新，且都使用同一快照", async () => {
    const file = path.join(env.project, "a.md")
    await env.write(file, "old")
    const plugin = await setup({ configPath: false, models: { "*": ["./a.md"] } })
    await env.write(file, "new prompt content")
    const readFile = fs.readFile
    const started = gate()
    const release = gate()
    const reads = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === file) {
        started.open()
        await release.promise
      }
      return readFile(...args)
    })
    const stat = vi.spyOn(fs, "stat")
    const first = plugin.invoke()
    await started.promise
    const before = stat.mock.calls.length
    const second = plugin.invoke()
    const duplicateCheck = stat.mock.calls.length > before
    release.open()
    expect(await Promise.all([first, second])).toEqual([["new prompt content"], ["new prompt content"]])
    expect(duplicateCheck).toBe(false)
    expect(reads.mock.calls.filter(([target]) => target === file)).toHaveLength(1)
  })
  it("连续保存超过重试预算时保留上一份快照，下一个 hook 继续尝试", async () => {
    const file = path.join(env.project, "a.md")
    await env.write(file, "last stable")
    const plugin = await setup({ configPath: false, models: { "*": ["./a.md"] } })
    await env.write(file, "current")
    const readFile = fs.readFile
    let editing = true
    let reads = 0
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const contents = await readFile(...args)
      if (args[0] === file && editing && reads < 10) await env.write(file, contents + `${++reads}`)
      return contents
    })
    expect(await plugin.invoke()).toEqual(["last stable"])
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThan(10)
    editing = false
    expect(await plugin.invoke()).toEqual([`current${"123456789".slice(0, reads)}`])
  })
  it("回退文件读取期间新建本地文件会覆盖全局，本地删除后恢复全局", async () => {
    await env.write(path.join(env.project, ".opencode", "model-prompts.jsonc"), '{"models":{"*":["shared.md"]}}')
    const global = path.join(env.global, "model-prompts", "shared.md")
    const local = path.join(env.project, ".opencode", "model-prompts", "shared.md")
    await env.write(global, "global")
    const readFile = fs.readFile
    let createLocal = false
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const contents = await readFile(...args)
      if (args[0] === global && createLocal) {
        createLocal = false
        await env.write(local, "local override")
      }
      return contents
    })
    const plugin = await setup({})
    expect(await plugin.invoke()).toEqual(["global"])
    await env.write(global, "updated global")
    createLocal = true
    const overridden = await plugin.invoke()
    await fs.unlink(local)
    const fallback = await plugin.invoke()
    expect(overridden).toEqual(["local override"])
    expect(fallback).toEqual(["updated global"])
  })
  it("缺失提示词在 setup 告警，之后补齐可热更新且不会崩溃", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const file = path.join(env.project, ".opencode", "model-prompts", "missing.md")
    const plugin = await setup({ models: { "*": ["missing.md"] } })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/无法读取提示词.*ENOENT/))
    expect(await plugin.invoke()).toEqual([])
    await fs.mkdir(path.dirname(file), { recursive: true })
    await env.write(file, "now present")
    expect(await plugin.invoke()).toEqual(["now present"])
  })
})
