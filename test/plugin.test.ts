import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Plugin } from "@opencode/plugin"
import SkillFilterPluginDefault, { SkillFilterPlugin } from "../src/index"
import type { MutableSkill, SkillEditorLike } from "../src/filter/apply"

interface CapturedCtx {
  ctx: any
  getCallback: () => ((editor: unknown) => void) | undefined
  transformCalls: number
}

function createMockCtx(options: Record<string, unknown>, projectDir: string): CapturedCtx {
  let callback: ((editor: unknown) => void) | undefined
  const state = { transformCalls: 0 }
  const ctx: any = {
    location: { directory: projectDir },
    options,
    skill: {
      transform: async (cb: (editor: unknown) => void) => {
        state.transformCalls += 1
        callback = cb
        return { dispose: async () => {} }
      },
    },
  }
  return {
    ctx,
    getCallback: () => callback,
    get transformCalls() {
      return state.transformCalls
    },
  } as CapturedCtx
}

function createEditor(skills: MutableSkill[]) {
  const store = new Map(skills.map((s) => [s.id as string, s]))
  const editor: SkillEditorLike = {
    list: () => Array.from(store.values()).map((s) => ({ ...s })),
    update: (id, updater) => {
      const target = store.get(id)
      if (target) updater(target)
    },
  }
  return { editor, store }
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
    expect(store.get("to-spec")?.autoinvoke).toBeUndefined()
    expect(store.get("keep")?.autoinvoke).toBeUndefined()
  })

  it("does not register a transform when no hide rules are configured", async () => {
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

  it("tolerates an options object with malformed values", async () => {
    const captured = createMockCtx({ hide: "nope", configPath: false }, projectDir)
    await expect(SkillFilterPlugin.setup(captured.ctx)).resolves.toBeUndefined()
    expect(captured.transformCalls).toBe(0)
  })
})
