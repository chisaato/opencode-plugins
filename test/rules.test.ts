import { describe, it, expect } from "vitest"
import { decideAction, hasWork } from "../src/matching/rules"
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

const skill = { id: "skill-to-spec", name: "to-spec" }

describe("decideAction", () => {
  it("hides a skill that matches a hide pattern", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"] }))
    expect(decision.action).toBe("hide")
    expect(decision.matched).toBe("to-*")
  })

  it("leaves a skill that matches nothing", () => {
    expect(decideAction({ name: "keep-me" }, rules({ hide: ["to-*"] })).action).toBe("leave")
  })

  it("lets unhide win over hide", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"], unhide: ["to-spec"] }))
    expect(decision.action).toBe("leave")
    expect(decision.reason).toContain("unhide")
  })

  it("restores (show) unhidden skills when restoreUnhidden is on", () => {
    const decision = decideAction(
      skill,
      rules({ hide: ["to-*"], unhide: ["to-spec"], restoreUnhidden: true }),
    )
    expect(decision.action).toBe("show")
  })

  it("lets exclude bypass an otherwise-matching hide", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"], exclude: ["to-spec"] }))
    expect(decision.action).toBe("leave")
    expect(decision.reason).toContain("exclude")
  })

  it("respects the include scope", () => {
    const inScope = decideAction({ name: "to-a" }, rules({ hide: ["*"], include: ["to-*"] }))
    expect(inScope.action).toBe("hide")

    const outOfScope = decideAction({ name: "other" }, rules({ hide: ["*"], include: ["to-*"] }))
    expect(outOfScope.action).toBe("leave")
    expect(outOfScope.reason).toContain("include")
  })

  it("matches against the skill id as well as the name", () => {
    const decision = decideAction({ id: "paseo/run", name: "run" }, rules({ hide: ["paseo/*"] }))
    expect(decision.action).toBe("hide")
  })

  it("prefers unhide over exclude", () => {
    const decision = decideAction(
      { name: "x" },
      rules({ unhide: ["x"], exclude: ["x"] }),
    )
    expect(decision.reason).toContain("unhide")
  })
})

describe("hasWork", () => {
  it("is false when nothing is configured", () => {
    expect(hasWork(rules())).toBe(false)
    expect(hasWork(rules({ include: ["to-*"], exclude: ["x"] }))).toBe(false)
  })

  it("is true when hide rules exist", () => {
    expect(hasWork(rules({ hide: ["to-*"] }))).toBe(true)
  })

  it("is true only when restoreUnhidden has unhide entries to act on", () => {
    expect(hasWork(rules({ unhide: ["to-spec"] }))).toBe(false)
    expect(hasWork(rules({ unhide: ["to-spec"], restoreUnhidden: true }))).toBe(true)
    expect(hasWork(rules({ restoreUnhidden: true }))).toBe(false)
  })
})
