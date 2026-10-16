import { describe, expect, it } from "vitest"
import { matchRule } from "../src/match"
import type { Rule } from "../src/config/schema"

function rule(overrides: Partial<Rule>): Rule {
  return {
    models: ["google/*"],
    errors: ["Provider blocked the response"],
    prompt: "继续",
    maxRetries: 3,
    delayMs: 2000,
    resetAfterToolCalls: 10,
    resetAfterMs: 120_000,
    ...overrides,
  }
}

describe("matchRule", () => {
  it("google/* 命中 google/gemini-3-pro，不命中 anthropic/claude", () => {
    const rules = [rule({ models: ["google/*"] })]

    expect(
      matchRule(rules, {
        model: "google/gemini-3-pro",
        errorMessage: "Provider blocked the response",
      })?.models,
    ).toEqual(["google/*"])
    expect(
      matchRule(rules, {
        model: "anthropic/claude",
        errorMessage: "Provider blocked the response",
      }),
    ).toBeUndefined()
  })

  it("errors 按子串匹配，模型与错误必须同时命中", () => {
    const rules = [rule({ models: ["google/gemini-3-pro"], errors: ["blocked"] })]

    expect(
      matchRule(rules, {
        model: "google/gemini-3-pro",
        errorMessage: "Provider blocked the response (safety)",
      }),
    ).toBe(rules[0])
    expect(
      matchRule(rules, {
        model: "google/gemini-3-pro",
        errorMessage: "rate limit",
      }),
    ).toBeUndefined()
  })

  it("从上到下第一条同时命中的规则生效", () => {
    const rules = [
      rule({ models: ["google/*"], errors: ["blocked"], prompt: "第一条" }),
      rule({ models: ["google/gemini-3-pro"], errors: ["blocked"], prompt: "第二条" }),
    ]

    expect(
      matchRule(rules, {
        model: "google/gemini-3-pro",
        errorMessage: "Provider blocked the response",
      })?.prompt,
    ).toBe("第一条")
  })

  it("models 列表里任意一个通配命中即可", () => {
    const rules = [rule({ models: ["anthropic/*", "google/gemini-3-pro"] })]

    expect(
      matchRule(rules, {
        model: "google/gemini-3-pro",
        errorMessage: "Provider blocked the response",
      }),
    ).toBe(rules[0])
  })
})
