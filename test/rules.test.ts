import { describe, it, expect } from "vitest"
import { decideAction, hasWork } from "../src/matching/rules"
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

const skill = { id: "skill-to-spec", name: "to-spec" }

describe("decideAction", () => {
  it("soft-hides a skill that matches a hide pattern", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"] }))
    expect(decision.action).toBe("hide")
    expect(decision.matched).toBe("to-*")
  })

  it("hard-removes a skill that matches a remove pattern", () => {
    const decision = decideAction(skill, rules({ remove: ["to-*"] }))
    expect(decision.action).toBe("remove")
    expect(decision.matched).toBe("to-*")
  })

  it("leaves a skill that matches nothing", () => {
    expect(decideAction({ name: "keep-me" }, rules({ hide: ["to-*"] })).action).toBe("leave")
  })

  it("enables (show) a skill that matches an enable pattern", () => {
    const decision = decideAction(skill, rules({ enable: ["to-spec"] }))
    expect(decision.action).toBe("show")
    expect(decision.matched).toBe("to-spec")
  })

  it("lets enable win over hide", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"], enable: ["to-spec"] }))
    expect(decision.action).toBe("show")
    expect(decision.reason).toContain("enable")
  })

  it("lets enable win over remove", () => {
    const decision = decideAction(skill, rules({ remove: ["*"], enable: ["to-spec"] }))
    expect(decision.action).toBe("show")
  })

  it("lets remove win over hide", () => {
    const decision = decideAction(skill, rules({ remove: ["to-*"], hide: ["to-*"] }))
    expect(decision.action).toBe("remove")
  })

  it("lets exclude bypass an otherwise-matching hide", () => {
    const decision = decideAction(skill, rules({ hide: ["to-*"], exclude: ["to-spec"] }))
    expect(decision.action).toBe("leave")
    expect(decision.reason).toContain("exclude")
  })

  it("lets exclude bypass an otherwise-matching remove", () => {
    const decision = decideAction(skill, rules({ remove: ["to-*"], exclude: ["to-spec"] }))
    expect(decision.action).toBe("leave")
  })

  it("respects the include scope", () => {
    const inScope = decideAction({ name: "to-a" }, rules({ hide: ["*"], include: ["to-*"] }))
    expect(inScope.action).toBe("hide")

    const outOfScope = decideAction({ name: "other" }, rules({ remove: ["*"], include: ["to-*"] }))
    expect(outOfScope.action).toBe("leave")
    expect(outOfScope.reason).toContain("include")
  })

  it("matches against the skill id as well as the name", () => {
    const decision = decideAction({ id: "paseo/run", name: "run" }, rules({ remove: ["paseo/*"] }))
    expect(decision.action).toBe("remove")
  })

  it("lets enable beat exclude (enable is the highest priority)", () => {
    const decision = decideAction(
      { name: "x" },
      rules({ enable: ["x"], exclude: ["x"] }),
    )
    expect(decision.action).toBe("show")
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

  it("is true when remove rules exist", () => {
    expect(hasWork(rules({ remove: ["paseo*"] }))).toBe(true)
  })

  it("is true when enable rules exist", () => {
    expect(hasWork(rules({ enable: ["to-spec"] }))).toBe(true)
  })
})
