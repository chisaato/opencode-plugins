import { describe, it, expect } from "vitest"
import {
  findTopLevelProperty,
  maskJsonComments,
  parseJsonc,
  stableStringify,
  structurallyEqual,
  stripTrailingCommas,
  upsertExperimentalPolicies,
} from "../src/config/jsonc"

describe("maskJsonComments", () => {
  it("replaces comments with equal-length whitespace", () => {
    const input = '{\n  // a line comment\n  "a": 1 /* block */\n}\n'
    const masked = maskJsonComments(input)
    expect(masked.length).toBe(input.length)
    expect(masked).not.toContain("// a line comment")
    expect(masked).not.toContain("block")
    // 换行数量保持不变
    expect(masked.split("\n").length).toBe(input.split("\n").length)
    // 掩码后仍是合法 JSON
    expect(() => JSON.parse(masked)).not.toThrow()
  })

  it("keeps comment-like sequences inside string literals", () => {
    const input = '{ "url": "https://x/y", "glob": "a/*b" }'
    const masked = maskJsonComments(input)
    expect(masked).toBe(input)
    expect(JSON.parse(masked).url).toBe("https://x/y")
  })

  it("preserves escaped quotes and backslashes", () => {
    const input = '{ "a": "he said \\"hi\\" \\\\ ok" }'
    const masked = maskJsonComments(input)
    expect(masked).toBe(input)
    expect(JSON.parse(masked).a).toContain('he said "hi"')
  })
})

describe("stripTrailingCommas", () => {
  it("removes trailing commas but keeps string content", () => {
    const cleaned = stripTrailingCommas('{ "a": [1, 2,], }')
    expect(cleaned).toBe('{ "a": [1, 2 ]  }')
    expect(JSON.parse(cleaned)).toEqual({ a: [1, 2] })
    expect(stripTrailingCommas('{ "s": "x,}" }')).toBe('{ "s": "x,}" }')
  })
})

describe("parseJsonc", () => {
  it("parses comments and trailing commas", () => {
    const text = `{
      // leading comment
      "a": 1,
      "b": [2, 3,],
    } /* trailing */
    `
    expect(parseJsonc(text)).toEqual({ a: 1, b: [2, 3] })
  })

  it("throws on genuinely invalid jsonc", () => {
    expect(() => parseJsonc("{ not json ")).toThrow()
  })

  it("strips a leading BOM and keeps string contents", () => {
    const text = '\uFEFF{\n  // note\n  "s": "keep // /* ,}",\n  "n": 1,\n}\n'
    expect(parseJsonc(text)).toEqual({ s: "keep // /* ,}", n: 1 })
    // 字符串内部的 BOM 不是文件头，必须保留。
    expect(parseJsonc('{ "s": "\uFEFFinside" }')).toEqual({ s: "\uFEFFinside" })
  })
})

describe("findTopLevelProperty", () => {
  it("locates a top-level key and ignores nested same-named keys", () => {
    const masked = maskJsonComments(`{
  "nested": { "experimental": 1 },
  "experimental": { "x": 2 }
}`)
    const span = findTopLevelProperty(masked, "experimental")
    expect(span).toBeDefined()
    expect(masked.slice(span!.valueStart, span!.valueEnd)).toBe('{ "x": 2 }')
  })

  it("returns undefined when missing", () => {
    expect(findTopLevelProperty(maskJsonComments('{ "a": 1 }'), "experimental")).toBeUndefined()
    expect(findTopLevelProperty("[1, 2]", "a")).toBeUndefined()
  })
})

describe("upsertExperimentalPolicies", () => {
  const deny = (resource: string) => ({
    action: "integration.use" as const,
    resource,
    effect: "deny" as const,
  })

  it("creates experimental.policies when absent and preserves other content", () => {
    const text = '{\n  // keep this comment\n  "$schema": "https://opencode.ai/config.json",\n  "model": "x"\n}\n'
    const { text: next, changed } = upsertExperimentalPolicies(text, [deny("skill:paseo*")])

    expect(changed).toBe(true)
    expect(next).toContain("// keep this comment")
    expect(next).toContain('"model": "x"')
    expect(parseJsonc(next)).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "x",
      experimental: { policies: [deny("skill:paseo*")] },
    })
  })

  it("inserts policies into an existing experimental object", () => {
    const text = '{\n  "experimental": {\n    "subagent_depth": 3\n  }\n}\n'
    const { text: next } = upsertExperimentalPolicies(text, [deny("skill:a")])
    expect(parseJsonc(next)).toEqual({
      experimental: { subagent_depth: 3, policies: [deny("skill:a")] },
    })
  })

  it("replaces an existing policies array while keeping user entries", () => {
    const userPolicy = { action: "tool.use", resource: "bash", effect: "allow" }
    const text = `{
  "experimental": {
    "policies": [
      { "action": "integration.use", "resource": "skill:old*", "effect": "deny" },
      { "action": "tool.use", "resource": "bash", "effect": "allow" }
    ]
  }
}
`
    const { text: next } = upsertExperimentalPolicies(text, [userPolicy, deny("skill:new*")])
    const parsed = parseJsonc(next)
    expect(parsed).toEqual({
      experimental: { policies: [userPolicy, deny("skill:new*")] },
    })
    // 用户手写的 allow policy 仍在
    expect(next).toContain('"resource": "bash"')
    expect(next).not.toContain("skill:old*")
  })

  it("is idempotent: running twice produces identical text", () => {
    const text = '{\n  "model": "x"\n}\n'
    const first = upsertExperimentalPolicies(text, [deny("skill:paseo*")])
    const second = upsertExperimentalPolicies(first.text, [deny("skill:paseo*")])
    expect(second.text).toBe(first.text)
    expect(second.changed).toBe(false)
  })

  it("handles an empty root object", () => {
    const { text: next } = upsertExperimentalPolicies("{}\n", [deny("skill:a")])
    expect(parseJsonc(next)).toEqual({ experimental: { policies: [deny("skill:a")] } })
  })

  it("writes an empty policies array", () => {
    const { text: next } = upsertExperimentalPolicies('{\n  "model": "x"\n}\n', [])
    expect(parseJsonc(next)).toEqual({ model: "x", experimental: { policies: [] } })
  })

  it("leaves non-object roots untouched", () => {
    const { text, changed } = upsertExperimentalPolicies("[1, 2]", [deny("skill:a")])
    expect(changed).toBe(false)
    expect(text).toBe("[1, 2]")
  })
})

describe("structurallyEqual / stableStringify", () => {
  it("ignores object key order", () => {
    expect(structurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })
})
