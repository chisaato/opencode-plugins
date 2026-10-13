import { describe, it, expect, vi } from "vitest"
import { applyFilter, collectSkills, type MutableSkill, type SkillEditorLike } from "../src/filter/apply"
import { createLogger } from "../src/utils/logger"
import type { NormalizedRules } from "../src/types"

function rules(partial: Partial<NormalizedRules> = {}): NormalizedRules {
  return {
    remove: [],
    hide: [],
    enable: [],
    include: [],
    exclude: [],
    ...partial,
  }
}

/**
 * 模拟 V2 SkillEditor：list() 返回副本，update()/remove() 写回真实 store。
 * `remove` 关闭时用于验证回退行为。
 */
function createEditor(skills: MutableSkill[], options: { withRemove?: boolean } = {}) {
  const withRemove = options.withRemove ?? true
  const store = new Map(skills.map((s) => [s.id as string, s]))
  const updateCalls: string[] = []
  const removeCalls: string[] = []
  const editor: SkillEditorLike = {
    list: () => Array.from(store.values()).map((s) => ({ ...s })),
    get: (id) => store.get(id),
    update: (id, updater) => {
      const target = store.get(id)
      if (!target) {
        throw new Error(`unknown skill: ${id}`)
      }
      updater(target)
      updateCalls.push(id)
    },
  }
  if (withRemove) {
    editor.remove = (id) => {
      if (!store.has(id)) {
        throw new Error(`unknown skill: ${id}`)
      }
      store.delete(id)
      removeCalls.push(id)
    }
  }
  return { editor, store, updateCalls, removeCalls }
}

describe("collectSkills", () => {
  it("uses list() when available", () => {
    const { editor } = createEditor([{ id: "a", name: "a" }, { id: "b", name: "b" }])
    expect(collectSkills(editor).map((s) => s.id)).toEqual(["a", "b"])
  })

  it("falls back to a record-shaped skills map", () => {
    const editor: SkillEditorLike = {
      skills: {
        "paseo-run": { id: "paseo-run", name: "paseo-run" },
        "inline-name": { name: "inline-name" },
      },
    }
    const collected = collectSkills(editor)
    expect(collected.map((s) => s.id).sort()).toEqual(["inline-name", "paseo-run"])
  })

  it("falls back to an array-shaped skills list", () => {
    const editor: SkillEditorLike = { skills: [{ id: "x", name: "x" }] }
    expect(collectSkills(editor).map((s) => s.id)).toEqual(["x"])
  })

  it("dedupes by id", () => {
    const editor: SkillEditorLike = {
      list: () => [
        { id: "dup", name: "dup" },
        { id: "dup", name: "dup-2" },
      ],
    }
    expect(collectSkills(editor)).toHaveLength(1)
  })

  it("returns [] for an empty editor", () => {
    expect(collectSkills({})).toEqual([])
  })
})

describe("applyFilter", () => {
  it("sets autoinvoke=false on hidden skills via editor.update", () => {
    const { editor, store, updateCalls } = createEditor([
      { id: "ask-matt", name: "ask-matt" },
      { id: "to-spec", name: "to-spec" },
      { id: "to-plan", name: "to-plan" },
      { id: "keep", name: "keep", autoinvoke: true },
    ])

    const result = applyFilter(editor, rules({ hide: ["ask-matt", "to-*"], enable: ["to-spec"] }))

    expect(store.get("ask-matt")?.autoinvoke).toBe(false)
    expect(store.get("to-plan")?.autoinvoke).toBe(false)
    // enable forces autoinvoke=true (explicit activation)
    expect(store.get("to-spec")?.autoinvoke).toBe(true)
    expect(store.get("keep")?.autoinvoke).toBe(true)
    expect(result.hidden.sort()).toEqual(["ask-matt", "to-plan"])
    expect(result.shown).toEqual(["to-spec"])
    expect(updateCalls.sort()).toEqual(["ask-matt", "to-plan", "to-spec"])
  })

  it("removes skills via editor.remove and records them", () => {
    const { editor, store, removeCalls } = createEditor([
      { id: "paseo-cli", name: "paseo-cli", description: "paseo" },
      { id: "keep", name: "keep" },
    ])

    const removed: Array<{ skill: MutableSkill; label: string }> = []
    const result = applyFilter(editor, rules({ remove: ["paseo*"] }), undefined, {
      onRemove: (skill, label) => removed.push({ skill, label }),
    })

    expect(store.has("paseo-cli")).toBe(false)
    expect(store.has("keep")).toBe(true)
    expect(removeCalls).toEqual(["paseo-cli"])
    expect(result.removed).toEqual(["paseo-cli"])
    expect(removed).toHaveLength(1)
    expect(removed[0]?.skill.id).toBe("paseo-cli")
    expect(removed[0]?.label).toBe("paseo-cli")
  })

  it("lets enable win over remove (nothing is removed)", () => {
    const { editor, store, removeCalls } = createEditor([
      { id: "to-spec", name: "to-spec" },
    ])
    const result = applyFilter(editor, rules({ remove: ["to-*"], enable: ["to-spec"] }))
    expect(store.has("to-spec")).toBe(true)
    expect(store.get("to-spec")?.autoinvoke).toBe(true)
    expect(removeCalls).toEqual([])
    expect(result.removed).toEqual([])
  })

  it("falls back to autoinvoke=false when editor.remove is unavailable", () => {
    const { editor, store } = createEditor([{ id: "paseo-cli", name: "paseo-cli" }], {
      withRemove: false,
    })
    const warn = vi.fn()
    const logger = createLogger(true, { debug: () => {}, info: () => {}, warn })
    const result = applyFilter(editor, rules({ remove: ["paseo*"] }), logger)
    expect(store.get("paseo-cli")?.autoinvoke).toBe(false)
    expect(result.removed).toEqual(["paseo-cli"])
    expect(warn).toHaveBeenCalled()
  })

  it("skips skills already at the desired value", () => {
    const { editor, updateCalls } = createEditor([
      { id: "ask-matt", name: "ask-matt", autoinvoke: false },
    ])
    const result = applyFilter(editor, rules({ hide: ["ask-matt"] }))
    expect(updateCalls).toEqual([])
    expect(result.hidden).toEqual([])
  })

  it("activates enabled skills to autoinvoke=true", () => {
    const { editor, store } = createEditor([
      { id: "to-spec", name: "to-spec", autoinvoke: false },
    ])
    const result = applyFilter(editor, rules({ hide: ["to-*"], enable: ["to-spec"] }))
    expect(store.get("to-spec")?.autoinvoke).toBe(true)
    expect(result.shown).toEqual(["to-spec"])
  })

  it("mutates the store in place when editor exposes only a record map", () => {
    const skills: Record<string, MutableSkill> = {
      "paseo-cli": { id: "paseo-cli", name: "paseo-cli" },
      other: { id: "other", name: "other" },
    }
    const result = applyFilter({ skills }, rules({ hide: ["paseo*"] }))
    expect(skills["paseo-cli"].autoinvoke).toBe(false)
    expect(skills.other.autoinvoke).toBeUndefined()
    expect(result.hidden).toEqual(["paseo-cli"])
  })

  it("matches by id (e.g. namespaced paths)", () => {
    const { editor, store } = createEditor([{ id: "vendor/grill", name: "grill-me" }])
    applyFilter(editor, rules({ hide: ["vendor/*"] }))
    expect(store.get("vendor/grill")?.autoinvoke).toBe(false)
  })

  it("applies include as a scope gate", () => {
    const { editor, store } = createEditor([
      { id: "to-a", name: "to-a" },
      { id: "vendor-b", name: "vendor-b" },
    ])
    applyFilter(editor, rules({ hide: ["*"], include: ["to-*"] }))
    expect(store.get("to-a")?.autoinvoke).toBe(false)
    expect(store.get("vendor-b")?.autoinvoke).toBeUndefined()
  })

  it("emits debug logs through an injected logger", () => {
    const messages: string[] = []
    const logger = createLogger(true, {
      debug: (m) => messages.push(String(m)),
      info: () => {},
      warn: () => {},
    })
    const { editor } = createEditor([{ id: "ask-matt", name: "ask-matt" }])
    applyFilter(editor, rules({ hide: ["ask-matt"] }), logger)
    expect(messages.join("\n")).toContain("set autoinvoke=false on ask-matt")
  })

  it("does not throw when editor.update fails; falls back to in-place mutation", () => {
    const skill: MutableSkill = { id: "x", name: "x" }
    const editor: SkillEditorLike = {
      list: () => [skill],
      update: () => {
        throw new Error("boom")
      },
    }
    const warn = vi.fn()
    const logger = createLogger(true, { debug: () => {}, info: () => {}, warn })
    expect(() => applyFilter(editor, rules({ hide: ["x"] }), logger)).not.toThrow()
    expect(skill.autoinvoke).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
