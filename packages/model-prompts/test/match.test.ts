import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { fixture } from "./helpers"
import { loadConfig } from "../src/config/loader"
import { collectPromptPaths, matchesGlob, matchesRule, resolvePromptPath } from "../src/match"

type Fixture = Awaited<ReturnType<typeof fixture>>
let env: Fixture
beforeEach(async () => { env = await fixture() })
afterEach(async () => { await env.cleanup() })

describe("匹配与路径解析", () => {
  it("glob 全锚定、支持跨斜线星号、单字符问号与 variant", async () => {
    expect(matchesGlob("a/b/c", "a*")).toBe(true)
    expect(matchesGlob("openai/gpt-5", "*/gpt-?")).toBe(true)
    expect(matchesGlob("xopenai/gpt-5", "openai/*")).toBe(false)
    const config = await loadConfig({ projectDirectory: env.project, inline: { models: { "openai/gpt-*@fast": ["a.md"], "openai/gpt-*": ["b.md"] } } })
    expect(matchesRule(config.rules[0]!, { model: { providerID: "openai", id: "gpt-5", variant: "fast" } })).toBe(true)
    expect(matchesRule(config.rules[0]!, { model: { providerID: "openai", id: "gpt-5" } })).toBe(false)
    expect(matchesRule(config.rules[1]!, { model: { providerID: "openai", id: "gpt-5", variant: "fast" } })).toBe(true)
  })
  it("models 键顺序后接 rules，按解析路径去重", async () => {
    const config = await loadConfig({ projectDirectory: env.project, inline: {
      models: { "openai/*": ["1.md", "2.md"], "*/gpt-*": ["2.md", "3.md"] },
      rules: [{ models: ["openai/*", "other/*"], prompts: ["3.md", "4.md"] }],
    } })
    const paths = await collectPromptPaths(config.rules, { model: { providerID: "openai", id: "gpt-5" } }, config.globalPromptsDir)
    expect(paths.map((file) => path.basename(file))).toEqual(["1.md", "2.md", "3.md", "4.md"])
  })
  it("代理过滤支持 ID 与名称候选，工具要求 own 属性", async () => {
    const config = await loadConfig({ projectDirectory: env.project, inline: {
      agents: ["orchestrator", "Agent ?"],
      excludeAgents: ["bad*"],
      requireTools: ["search"],
      models: { "*": ["a.md"] },
    } })
    const rule = config.rules[0]!
    const model = { providerID: "openai", id: "gpt-5" }
    expect(matchesRule(rule, { model, agents: ["Agent A"], tools: { search: true } })).toBe(true)
    expect(matchesRule(rule, { model, agents: ["orchestrator", "bad-agent"], tools: { search: true } })).toBe(false)
    expect(matchesRule(rule, { model, agent: "orchestrator", tools: Object.create({ search: true }) as Record<string, unknown> })).toBe(false)
  })
  it("promptsDir 覆盖、显式相对路径、HOME 展开与项目文件回退全局", async () => {
    const config = await loadConfig({ projectDirectory: env.project, inline: { promptsDir: "custom", models: { "*": ["nested/a.md", "./direct.md", "~/home.md"] } } })
    const rule = config.rules[0]!
    expect(await resolvePromptPath("./direct.md", rule, config.globalPromptsDir)).toBe(path.join(env.project, "direct.md"))
    expect(await resolvePromptPath("~/home.md", rule, config.globalPromptsDir)).toBe(path.join(env.root, "home.md"))
    expect(await resolvePromptPath("nested/a.md", rule, config.globalPromptsDir)).toBe(path.join(env.global, "model-prompts", "nested", "a.md"))
    await env.write(path.join(env.project, "custom", "nested", "a.md"), "local")
    expect(await resolvePromptPath("nested/a.md", rule, config.globalPromptsDir)).toBe(path.join(env.project, "custom", "nested", "a.md"))
  })
})
