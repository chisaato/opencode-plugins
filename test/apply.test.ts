import { describe, it, expect, vi } from "vitest"
import { applyFilter, collectSkills, type MutableSkill, type SkillEditorLike } from "../src/filter/apply"
import { createLogger } from "../src/utils/logger"
import type { NormalizedRules } from "../src/types"

function rules(partial: Partial<NormalizedRules> = {}): NormalizedRules {
  return {
    hide: [],
    unhide: [],
    include: [],
    exclude: [],
    restoreUnhidden: false,
    ...partial,
  }
}

/** 模拟 V2 SkillEditor：list() 返回副本，update() 写回真实对象。 */
function createEditor(skills: MutableSkill[]) {
  const store = new Map(skills.map((s) => [s.id as string, s]))
  const updateCalls: string[] = []
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
  return { editor, store, updateCalls }
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

    const result = applyFilter(editor, rules({ hide: ["ask-matt", "to-*"], unhide: ["to-spec"] }))

    expect(store.get("ask-matt")?.autoinvoke).toBe(false)
    expect(store.get("to-plan")?.autoinvoke).toBe(false)
    // unhide keeps its value untouched
    expect(store.get("to-spec")?.autoinvoke).toBeUndefined()
    expect(store.get("keep")?.autoinvoke).toBe(true)
    expect(result.hidden.sort()).toEqual(["ask-matt", "to-plan"])
    expect(updateCalls.sort()).toEqual(["ask-matt", "to-plan"])
  })

  it("skips skills already at the desired value", () => {
    const { editor, updateCalls } = createEditor([
      { id: "ask-matt", name: "ask-matt", autoinvoke: false },
    ])
    const result = applyFilter(editor, rules({ hide: ["ask-matt"] }))
    expect(updateCalls).toEqual([])
    expect(result.hidden).toEqual([])
  })

  it("restores unhidden skills to autoinvoke=true when configured", () => {
    const { editor, store } = createEditor([
      { id: "to-spec", name: "to-spec", autoinvoke: false },
    ])
    const result = applyFilter(
      editor,
      rules({ hide: ["to-*"], unhide: ["to-spec"], restoreUnhidden: true }),
    )
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
