import { describe, it, expect } from "vitest"
import {
  globToRegExp,
  matchesPattern,
  normalizePatterns,
  firstMatchingPattern,
} from "../src/matching/glob"

describe("globToRegExp / matchesPattern", () => {
  it("matches exact names", () => {
    expect(matchesPattern("ask-matt", "ask-matt")).toBe(true)
    expect(matchesPattern("ask-matt", "ask-mattx")).toBe(false)
    expect(matchesPattern("ask-matt-x", "ask-matt")).toBe(false)
  })

  it("matches prefix wildcards like to-* and paseo*", () => {
    expect(matchesPattern("to-spec", "to-*")).toBe(true)
    expect(matchesPattern("to-", "to-*")).toBe(true)
    expect(matchesPattern("to", "to-*")).toBe(false)
    expect(matchesPattern("atto", "to-*")).toBe(false)

    expect(matchesPattern("paseo", "paseo*")).toBe(true)
    expect(matchesPattern("paseo-cli", "paseo*")).toBe(true)
    expect(matchesPattern("mypaseo", "paseo*")).toBe(false)
  })

  it("is anchored on both ends for grill*", () => {
    expect(matchesPattern("grill", "grill*")).toBe(true)
    expect(matchesPattern("grilling", "grill*")).toBe(true)
    expect(matchesPattern("regrill", "grill*")).toBe(false)
  })

  it("supports ? as a single character", () => {
    expect(matchesPattern("ab", "a?")).toBe(true)
    expect(matchesPattern("abc", "a?")).toBe(false)
  })

  it("escapes regex metacharacters so they match literally", () => {
    expect(matchesPattern("a.b", "a.b")).toBe(true)
    expect(matchesPattern("axb", "a.b")).toBe(false)
    expect(matchesPattern("a+b", "a+b")).toBe(true)
    expect(matchesPattern("(x)", "(x)")).toBe(true)
  })

  it("does not treat an empty value or pattern as a match", () => {
    expect(matchesPattern("", "*")).toBe(false)
    expect(matchesPattern("anything", "")).toBe(false)
  })

  it("exposes a usable RegExp", () => {
    const re = globToRegExp("to-*")
    expect(re.test("to-spec")).toBe(true)
    expect(re.test("nope")).toBe(false)
  })
})

describe("firstMatchingPattern", () => {
  it("returns the first matching rule", () => {
    expect(firstMatchingPattern("to-spec", ["ask-matt", "to-*", "*"])).toBe("to-*")
    expect(firstMatchingPattern("keep", ["ask-matt", "to-*"])).toBeUndefined()
  })
})

describe("normalizePatterns", () => {
  it("trims, drops empties, dedupes and keeps order", () => {
    expect(
      normalizePatterns(["  to-*  ", "to-*", "", "  ", "ask-matt", 42, null]),
    ).toEqual(["to-*", "ask-matt"])
  })

  it("returns empty array for non-array input", () => {
    expect(normalizePatterns("to-*")).toEqual([])
    expect(normalizePatterns(undefined)).toEqual([])
  })
})
