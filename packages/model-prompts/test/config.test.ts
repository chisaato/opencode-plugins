import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import { fixture } from "./helpers"
import { loadConfig, parseJsonc, getGlobalConfigDir } from "../src/index"

type Fixture = Awaited<ReturnType<typeof fixture>>
let env: Fixture
beforeEach(async () => { env = await fixture() })
afterEach(async () => { await env.cleanup(); vi.restoreAllMocks() })

describe("JSONC 与多层配置", () => {
  it("解析注释、尾逗号、BOM；保留字符串里的注释样文本", () => {
    expect(parseJsonc('\uFEFF{/* block */ "models": {"x": ["a//b.md",],},}')).toEqual({
      models: { x: ["a//b.md"] },
    })
  })
  it("jsonc 损坏时不降级同目录 json，并报告警告", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await env.write(path.join(env.global, "model-prompts.jsonc"), "{broken")
    await env.write(path.join(env.global, "model-prompts.json"), '{"models":{"*":["ignored.md"]}}')
    const config = await loadConfig({ projectDirectory: env.project })
    expect(config.rules).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
  it("项目首组 jsonc 损坏时不读取同组 json 或项目根配置", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await env.write(path.join(env.project, ".opencode", "model-prompts.jsonc"), "{broken")
    await env.write(path.join(env.project, ".opencode", "model-prompts.json"), '{"models":{"wrong/*":["x.md"]}}')
    await env.write(path.join(env.project, "model-prompts.json"), '{"models":{"also-wrong/*":["x.md"]}}')
    expect((await loadConfig({ projectDirectory: env.project })).rules).toEqual([])
  })
  it("全局、项目和内联按序叠加；replace 清除之前规则", async () => {
    await env.write(path.join(env.global, "model-prompts.json"), '{"models":{"global/*":["a.md"]}}')
    await env.write(path.join(env.project, ".opencode", "model-prompts.jsonc"), '{"models":{"project/*":["b.md"]}}')
    const combined = await loadConfig({ projectDirectory: env.project, inline: { models: { "inline/*": ["c.md"] } } })
    expect(combined.rules.map((rule) => rule.models[0])).toEqual(["global/*", "project/*", "inline/*"])
    expect((await loadConfig({ projectDirectory: env.project, inline: { replace: true, models: { "inline/*": ["c.md"] } } })).rules.map((rule) => rule.models[0])).toEqual(["inline/*"])
    await env.write(path.join(env.project, ".opencode", "model-prompts.jsonc"), '{"replace":true,"models":{"project/*":["b.md"]}}')
    expect((await loadConfig({ projectDirectory: env.project })).rules.map((rule) => rule.models[0])).toEqual(["project/*"])
  })
  it("不接受包含换行的提示词字符串", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await loadConfig({ projectDirectory: env.project, inline: { models: { "*": ["plain.md", "inline\nprompt"] } } })
    expect(result.rules[0]?.prompts).toEqual(["plain.md"])
    expect(warn).toHaveBeenCalled()
  })
  it("隔离 OPENCODE_TEST_HOME / XDG_CONFIG_HOME，显式 HOME 优先", async () => {
    expect(getGlobalConfigDir()).toBe(env.global)
    delete process.env.OPENCODE_TEST_HOME
    process.env.XDG_CONFIG_HOME = path.join(env.root, "xdg")
    expect(getGlobalConfigDir()).toBe(path.join(env.root, "xdg", "opencode"))
    expect(getGlobalConfigDir({ homeDirectory: env.root })).toBe(env.global)
    await env.write(path.join(env.root, "xdg", "opencode", "model-prompts.json"), '{"models":{"xdg/*":["x.md"]}}')
    expect((await loadConfig({ projectDirectory: env.project })).rules[0]?.models).toEqual(["xdg/*"])
  })
  it("configPath:false 不读文件；显式路径只读取指定文件", async () => {
    await env.write(path.join(env.global, "model-prompts.json"), '{"models":{"global/*":["x.md"]}}')
    expect((await loadConfig({ projectDirectory: env.project, inline: { configPath: false } })).rules).toEqual([])
    const file = path.join(env.project, "custom.jsonc")
    await env.write(file, '{"models":{"custom/*":["x.md"]}}')
    expect((await loadConfig({ projectDirectory: env.project, inline: { configPath: file } })).rules[0]?.models).toEqual(["custom/*"])
  })
})
