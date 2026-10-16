import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Plugin } from "@opencode/plugin"
import SkillFilterPluginDefault, { SkillFilterPlugin } from "../src/index"
import { parseJsonc } from "../src/config/jsonc"
import type { MutableSkill, SkillEditorLike } from "../src/filter/apply"

interface CapturedCtx {
  ctx: any
  getCallback: () => ((editor: unknown) => void) | undefined
  getTool: (name: string) => any
  transformCalls: number
  toolTransformCalls: number
}

function createMockCtx(
  options: Record<string, unknown>,
  projectDir: string,
  skills: MutableSkill[] = [],
): CapturedCtx {
  let callback: ((editor: unknown) => void) | undefined
  const state = { transformCalls: 0, toolTransformCalls: 0 }
  const tools = new Map<string, any>()
  const ctx: any = {
    location: { directory: projectDir },
    options,
    skill: {
      transform: async (cb: (editor: unknown) => void) => {
        state.transformCalls += 1
        callback = cb
        return { dispose: async () => {} }
      },
      list: async () => ({ location: { directory: projectDir }, data: skills }),
      reload: async () => {},
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        state.toolTransformCalls += 1
        const editor = {
          list: () => Array.from(tools.values()),
          get: (id: string) => tools.get(id),
          namespace: () => {},
          add: (tool: any) => {
            tools.set(tool.name, tool)
          },
          update: (id: string, updater: (tool: any) => void) => {
            const target = tools.get(id)
            if (target) updater(target)
          },
          remove: (id: string) => {
            tools.delete(id)
          },
        }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => Array.from(tools.values()),
      reload: async () => {},
    },
  }
  return {
    ctx,
    getCallback: () => callback,
    getTool: (name: string) => tools.get(name),
    get transformCalls() {
      return state.transformCalls
    },
    get toolTransformCalls() {
      return state.toolTransformCalls
    },
  } as CapturedCtx
}

function createEditor(skills: MutableSkill[]) {
  const store = new Map(skills.map((s) => [s.id as string, s]))
  const removedIds: string[] = []
  const editor: SkillEditorLike = {
    list: () => Array.from(store.values()).map((s) => ({ ...s })),
    get: (id) => store.get(id),
    update: (id, updater) => {
      const target = store.get(id)
      if (target) updater(target)
    },
    remove: (id) => {
      store.delete(id)
      removedIds.push(id)
    },
  }
  return { editor, store, removedIds }
}

describe("plugin contract", () => {
  it("exports a Plugin.define result with the expected id and default export", async () => {
    const mod = await import("../src/index")
    expect(mod.default).toBe(SkillFilterPlugin)
    expect(mod.default.id).toBe("opencode-skill-filter")
    expect(typeof mod.default.setup).toBe("function")
    expect(SkillFilterPluginDefault).toBe(SkillFilterPlugin)
    // sanity: same shape as Plugin.define output
    expect(SkillFilterPlugin).toBe(Plugin.define(SkillFilterPlugin))
  })

  it("re-exports through the root directory-plugin entry", async () => {
    const root = await import("../index")
    expect(root.default).toBe(SkillFilterPlugin)
    expect(root.SkillFilterPlugin).toBe(SkillFilterPlugin)
  })
})

describe("plugin setup", () => {
  let root: string
  let projectDir: string
  let home: string
  const prevHome = process.env.OPENCODE_TEST_HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-plugin-"))
    projectDir = path.join(root, "project")
    home = path.join(root, "home")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.OPENCODE_TEST_HOME
    } else {
      process.env.OPENCODE_TEST_HOME = prevHome
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it("registers a skill transform and hides matching skills", async () => {
    const captured = createMockCtx({ hide: ["ask-matt", "to-*"], unhide: ["to-spec"], configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    expect(callback).toBeDefined()

    const { editor, store } = createEditor([
      { id: "ask-matt", name: "ask-matt" },
      { id: "to-spec", name: "to-spec" },
      { id: "to-plan", name: "to-plan" },
      { id: "keep", name: "keep" },
    ])
    callback!(editor)

    expect(store.get("ask-matt")?.autoinvoke).toBe(false)
    expect(store.get("to-plan")?.autoinvoke).toBe(false)
    // legacy unhide → enable → explicitly activated
    expect(store.get("to-spec")?.autoinvoke).toBe(true)
    expect(store.get("keep")?.autoinvoke).toBeUndefined()
  })

  it("hard-removes matching skills via editor.remove", async () => {
    const captured = createMockCtx({ remove: ["paseo*"], configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    const { editor, store, removedIds } = createEditor([
      { id: "paseo-cli", name: "paseo-cli" },
      { id: "keep", name: "keep" },
    ])
    callback!(editor)

    expect(store.has("paseo-cli")).toBe(false)
    expect(store.has("keep")).toBe(true)
    expect(removedIds).toEqual(["paseo-cli"])
  })

  it("lets enable override remove (enable has the highest priority)", async () => {
    const captured = createMockCtx({ remove: ["to-*"], enable: ["to-spec"], configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    const { editor, store, removedIds } = createEditor([
      { id: "to-spec", name: "to-spec" },
      { id: "to-plan", name: "to-plan" },
    ])
    callback!(editor)

    expect(store.has("to-spec")).toBe(true)
    expect(store.get("to-spec")?.autoinvoke).toBe(true)
    expect(store.has("to-plan")).toBe(false)
    expect(removedIds).toEqual(["to-plan"])
  })

  it("does not register a transform when no rules are configured", async () => {
    const captured = createMockCtx({ configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)
    expect(captured.transformCalls).toBe(0)
    expect(captured.getCallback()).toBeUndefined()
  })

  it("reads configuration from the project .opencode/skill-filter.json", async () => {
    const configDir = path.join(projectDir, ".opencode")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, "skill-filter.json"),
      JSON.stringify({ hide: ["paseo*"] }),
    )

    const captured = createMockCtx({}, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    expect(callback).toBeDefined()

    const { editor, store } = createEditor([{ id: "paseo-cli", name: "paseo-cli" }])
    callback!(editor)
    expect(store.get("paseo-cli")?.autoinvoke).toBe(false)
  })

  it("lets inline plugin options override the on-disk config", async () => {
    const configDir = path.join(projectDir, ".opencode")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, "skill-filter.json"),
      JSON.stringify({ hide: ["from-file"] }),
    )

    const captured = createMockCtx({ hide: ["from-inline"] }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    expect(callback).toBeDefined()

    const { editor, store } = createEditor([
      { id: "from-file", name: "from-file" },
      { id: "from-inline", name: "from-inline" },
    ])
    callback!(editor)

    expect(store.get("from-inline")?.autoinvoke).toBe(false)
    expect(store.get("from-file")?.autoinvoke).toBeUndefined()
  })

  it("applies a global directory override matched by the project path", async () => {
    // 全局配置里针对 “project” 目录写 override：彻底掩埋 paseo*
    await fs.writeFile(
      path.join(home, ".config", "opencode", "skill-filter.json"),
      JSON.stringify({
        hide: ["base-hide"],
        overrides: { "*/project": { remove: ["paseo*"], enable: ["base-hide"] } },
      }),
    )

    const captured = createMockCtx({}, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    expect(callback).toBeDefined()

    const { editor, store } = createEditor([
      { id: "paseo-cli", name: "paseo-cli" },
      { id: "base-hide", name: "base-hide" },
    ])
    callback!(editor)

    expect(store.has("paseo-cli")).toBe(false)
    expect(store.get("base-hide")?.autoinvoke).toBe(true)
  })

  it("tolerates an options object with malformed values", async () => {
    const captured = createMockCtx({ hide: "nope", configPath: false }, projectDir)
    await expect(SkillFilterPlugin.setup(captured.ctx)).resolves.toBeUndefined()
    expect(captured.transformCalls).toBe(0)
  })
})

describe("kernel policy sync", () => {
  let root: string
  let projectDir: string
  let home: string
  let target: string
  const prevHome = process.env.OPENCODE_TEST_HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-policy-plugin-"))
    projectDir = path.join(root, "project")
    home = path.join(root, "home")
    target = path.join(home, ".config", "opencode", "opencode.jsonc")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.OPENCODE_TEST_HOME
    } else {
      process.env.OPENCODE_TEST_HOME = prevHome
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it("writes remove rules as deny policies by default", async () => {
    await fs.writeFile(target, '{\n  // keep me\n  "model": "x"\n}\n')

    const captured = createMockCtx({ remove: ["paseo*"], configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    const after = await fs.readFile(target, "utf-8")
    expect(after).toContain("// keep me")
    const parsed = parseJsonc(after) as {
      model: string
      experimental: { policies: unknown[] }
    }
    expect(parsed.model).toBe("x")
    expect(parsed.experimental.policies).toEqual([
      { action: "integration.use", resource: "skill:paseo*", effect: "deny" },
    ])
  })

  it("exposes the policy summary through skills_list", async () => {
    await fs.writeFile(target, "{}\n")
    const captured = createMockCtx({ remove: ["paseo*"], configPath: false }, projectDir, [
      { id: "keep", name: "keep" },
    ])
    await SkillFilterPlugin.setup(captured.ctx)

    const result = await captured.getTool("skills_list").execute({ status: "all" }, {})
    expect(result.metadata.policies).toMatchObject({
      patterns: ["paseo*"],
      synced: true,
      written: true,
      path: target,
    })
    expect(result.content[0].text).toContain("policy: synced=true (written)")
  })

  it("does not write when syncPolicy is disabled", async () => {
    await fs.writeFile(target, '{ "model": "x" }\n')
    const captured = createMockCtx(
      { remove: ["paseo*"], configPath: false, syncPolicy: false },
      projectDir,
    )
    await SkillFilterPlugin.setup(captured.ctx)

    expect(await fs.readFile(target, "utf-8")).toBe('{ "model": "x" }\n')
  })

  it("honours an explicit syncPolicyPath", async () => {
    const explicit = path.join(root, "explicit.jsonc")
    const captured = createMockCtx(
      { remove: ["paseo*"], configPath: false, syncPolicyPath: explicit },
      projectDir,
    )
    await SkillFilterPlugin.setup(captured.ctx)

    const parsed = parseJsonc(await fs.readFile(explicit, "utf-8"))
    expect(parsed).toEqual({ experimental: { policies: [expect.objectContaining({ resource: "skill:paseo*" })] } })
  })

  it("re-applies removal when a compatibility layer injects the skill again", async () => {
    const captured = createMockCtx({ remove: ["paseo*"], configPath: false }, projectDir, [
      { id: "keep", name: "keep" },
    ])
    await SkillFilterPlugin.setup(captured.ctx)

    const callback = captured.getCallback()
    expect(callback).toBeDefined()

    // 第一次组装：移除 paseo-cli
    const first = createEditor([
      { id: "paseo-cli", name: "paseo-cli" },
      { id: "keep", name: "keep" },
    ])
    callback!(first.editor)
    expect(first.store.has("paseo-cli")).toBe(false)

    // 兼容层重载后又注入了 paseo-cli：第二次组装应再次剔除
    const second = createEditor([
      { id: "paseo-cli", name: "paseo-cli" },
      { id: "keep", name: "keep" },
    ])
    callback!(second.editor)
    expect(second.store.has("paseo-cli")).toBe(false)
    expect(second.removedIds).toEqual(["paseo-cli"])

    // 多次调用不会重复计数
    const result = await captured.getTool("skills_list").execute({ status: "removed" }, {})
    expect(result.metadata.removed).toBe(1)
  })
})

describe("skills_list tool registration", () => {
  let root: string
  let projectDir: string
  let home: string
  const prevHome = process.env.OPENCODE_TEST_HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-filter-tool-"))
    projectDir = path.join(root, "project")
    home = path.join(root, "home")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.OPENCODE_TEST_HOME
    } else {
      process.env.OPENCODE_TEST_HOME = prevHome
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it("registers skills_list through ctx.tool.transform by default", async () => {
    const captured = createMockCtx({ configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)

    expect(captured.toolTransformCalls).toBe(1)
    const tool = captured.getTool("skills_list")
    expect(tool).toBeDefined()
    expect(tool.description).toContain("autoinvoke")
    expect(tool.input.type).toBe("object")
  })

  it("registers the tool even when no rules are configured", async () => {
    const captured = createMockCtx({ configPath: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)
    // 没有任何治理规则 → 不注册 skill transform，但工具仍应可用。
    expect(captured.transformCalls).toBe(0)
    expect(captured.getTool("skills_list")).toBeDefined()
  })

  it("does not register the tool when exposeTool is false", async () => {
    const captured = createMockCtx({ configPath: false, exposeTool: false }, projectDir)
    await SkillFilterPlugin.setup(captured.ctx)
    expect(captured.toolTransformCalls).toBe(0)
    expect(captured.getTool("skills_list")).toBeUndefined()
  })

  it("skills_list execute reports totals and honours the status filter", async () => {
    const captured = createMockCtx({ configPath: false }, projectDir, [
      { id: "alpha", name: "alpha", description: "first", autoinvoke: true },
      { id: "beta", name: "beta", autoinvoke: false },
      { id: "gamma", name: "gamma" },
    ])
    await SkillFilterPlugin.setup(captured.ctx)

    const tool = captured.getTool("skills_list")
    const result = await tool.execute({ status: "all" }, {})

    expect(result.metadata.total).toBe(3)
    expect(result.metadata.active).toBe(2)
    expect(result.metadata.hidden).toBe(1)
    expect(result.metadata.removed).toBe(0)
    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toContain("total=3")
    expect(result.content[0].text).toContain("[hidden] beta")

    const hiddenOnly = await tool.execute({ status: "hidden" }, {})
    expect(hiddenOnly.metadata.status).toBe("hidden")
    expect(hiddenOnly.metadata.skills.map((entry: { name: string }) => entry.name)).toEqual(["beta"])

    const activeOnly = await tool.execute({ status: "active" }, {})
    expect(activeOnly.metadata.skills.map((entry: { name: string }) => entry.name)).toEqual([
      "alpha",
      "gamma",
    ])
  })

  it("skills_list execute reports removed skills recorded during applyFilter", async () => {
    // 模拟“移除后”的存活列表：只剩 keep。
    const captured = createMockCtx({ remove: ["paseo*"], configPath: false }, projectDir, [
      { id: "keep", name: "keep" },
    ])
    await SkillFilterPlugin.setup(captured.ctx)

    // 触发 transform，让插件记录被移除的 paseo-cli。
    const { editor } = createEditor([
      { id: "paseo-cli", name: "paseo-cli", description: "paseo tool" },
      { id: "keep", name: "keep" },
    ])
    captured.getCallback()!(editor)

    const tool = captured.getTool("skills_list")
    const all = await tool.execute({ status: "all" }, {})
    expect(all.metadata.total).toBe(2)
    expect(all.metadata.active).toBe(1)
    expect(all.metadata.removed).toBe(1)
    expect(all.content[0].text).toContain("[removed] paseo-cli")

    const removedOnly = await tool.execute({ status: "removed" }, {})
    expect(removedOnly.metadata.skills.map((entry: { name: string }) => entry.name)).toEqual([
      "paseo-cli",
    ])
  })

  it("skills_list execute defaults to all on unknown status", async () => {
    const captured = createMockCtx({ configPath: false }, projectDir, [
      { id: "alpha", name: "alpha" },
      { id: "beta", name: "beta", autoinvoke: false },
    ])
    await SkillFilterPlugin.setup(captured.ctx)

    const result = await captured.getTool("skills_list").execute({ status: "bogus" }, {})
    expect(result.metadata.status).toBe("all")
    expect(result.metadata.skills).toHaveLength(2)
  })
})
