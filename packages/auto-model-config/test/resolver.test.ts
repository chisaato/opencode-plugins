import { describe, it, expect } from "vitest"
import { resolveModel, resolveProviderModels } from "../src/mapping/resolver"
import type { ModelsDevData, AutoModelConfig } from "../src/types"

// 模拟真实 models.dev 结构的测试夹具
const testData: ModelsDevData = {
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    doc: "https://platform.openai.com/docs/models",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        attachment: true,
        reasoning: false,
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: "2024-05-13",
        last_updated: "2024-08-06",
        modalities: { input: ["text", "image"], output: ["text"] },
        open_weights: false,
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    api: "https://api.opencode.ai",
    doc: "",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        release_date: "2025-08-31",
        last_updated: "2025-08-31",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        open_weights: false,
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        knowledge: "2025-08-31",
      },
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        family: "gpt",
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        release_date: "2025-08-31",
        last_updated: "2025-08-31",
        modalities: { input: ["text", "image"], output: ["text"] },
        open_weights: false,
        cost: { input: 0.75, output: 4.5, cache_read: 0.075 },
        limit: { context: 400000, input: 272000, output: 128000 },
        knowledge: "2025-08-31",
      },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@ai-sdk/openai-compatible",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    doc: "https://openrouter.ai/docs",
    models: {
      "openai/gpt-5.4": {
        id: "openai/gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        release_date: "2025-08-31",
        last_updated: "2025-08-31",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        open_weights: false,
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        knowledge: "2025-08-31",
      },
      "anthropic/claude-3.5-haiku": {
        id: "anthropic/claude-3.5-haiku",
        name: "Claude 3.5 Haiku",
        family: "claude",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        release_date: "2024-10-22",
        last_updated: "2024-10-22",
        modalities: { input: ["text", "image"], output: ["text"] },
        open_weights: false,
        cost: { input: 1, output: 5, cache_read: 0.1 },
        limit: { context: 200000, output: 8192 },
      },
    },
  },
}

const testConfig: AutoModelConfig = {
  mapping: {
    "misaka-newapi": {
      "gpt-5.4": "opencode-go/gpt-5.4",
      "gpt-4o": "openai/gpt-4o",
      "unknown-model": "nonexistent-provider/nonexistent-model",
      "bad-format": "no-slash-here",
    },
    "my-openrouter": {
      "gpt-5.4": "openrouter/openai/gpt-5.4",
      haiku: "openrouter/anthropic/claude-3.5-haiku",
    },
  },
}

describe("resolveModel", () => {
  it("resolves a valid mapping", () => {
    const result = resolveModel(testData, testConfig, "misaka-newapi", "gpt-5.4")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("opencode-go/gpt-5.4")
    expect(result!.warning).toBeUndefined()
    expect(result!.modelData.name).toBe("GPT-5.4")
    expect(result!.filledFields).toContain("name")
    expect(result!.filledFields).toContain("capabilities")
    expect(result!.filledFields).toContain("limit")
  })

  it("resolves a different provider mapping", () => {
    const result = resolveModel(testData, testConfig, "misaka-newapi", "gpt-4o")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("openai/gpt-4o")
    expect(result!.modelData.name).toBe("GPT-4o")
  })

  it("returns warning for unknown provider", () => {
    const result = resolveModel(testData, testConfig, "misaka-newapi", "unknown-model")
    expect(result).not.toBeNull()
    expect(result!.warning).toContain("not found")
    expect(result!.filledFields).toHaveLength(0)
  })

  it("returns warning for bad format", () => {
    const result = resolveModel(testData, testConfig, "misaka-newapi", "bad-format")
    expect(result).not.toBeNull()
    expect(result!.warning).toContain("Invalid mapping format")
  })

  it("returns null for unmapped model", () => {
    const result = resolveModel(testData, testConfig, "misaka-newapi", "unmapped-model")
    expect(result).toBeNull()
  })

  it("returns null for unmapped provider", () => {
    const result = resolveModel(testData, testConfig, "unmapped-provider", "gpt-4o")
    expect(result).toBeNull()
  })

  it("resolves multi-slash model ID (openrouter/openai/gpt-5.4)", () => {
    const result = resolveModel(testData, testConfig, "my-openrouter", "gpt-5.4")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("openrouter/openai/gpt-5.4")
    expect(result!.warning).toBeUndefined()
    expect(result!.modelData.name).toBe("GPT-5.4")
    expect(result!.filledFields).toContain("name")
    expect(result!.filledFields).toContain("capabilities")
    expect(result!.filledFields).toContain("limit")
  })

  it("resolves multi-slash model ID with 3 slashes (openrouter/anthropic/claude-3.5-haiku)", () => {
    const result = resolveModel(testData, testConfig, "my-openrouter", "haiku")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("openrouter/anthropic/claude-3.5-haiku")
    expect(result!.warning).toBeUndefined()
    expect(result!.modelData.name).toBe("Claude 3.5 Haiku")
    expect(result!.modelData.family).toBe("claude")
  })
})

describe("resolveProviderModels", () => {
  it("resolves all models for a provider", () => {
    const results = resolveProviderModels(testData, testConfig, "misaka-newapi")
    expect(results.size).toBe(4) // 2 valid + 2 with warnings

    const valid = results.get("gpt-5.4")!
    expect(valid.warning).toBeUndefined()
    expect(valid.modelData.name).toBe("GPT-5.4")

    const notFound = results.get("unknown-model")!
    expect(notFound.warning).toBeDefined()

    const badFormat = results.get("bad-format")!
    expect(badFormat.warning).toContain("Invalid mapping format")
  })

  it("resolves all models for openrouter with multi-slash IDs", () => {
    const results = resolveProviderModels(testData, testConfig, "my-openrouter")
    expect(results.size).toBe(2)

    const gpt = results.get("gpt-5.4")!
    expect(gpt.warning).toBeUndefined()
    expect(gpt.source).toBe("openrouter/openai/gpt-5.4")
    expect(gpt.modelData.name).toBe("GPT-5.4")

    const haiku = results.get("haiku")!
    expect(haiku.warning).toBeUndefined()
    expect(haiku.source).toBe("openrouter/anthropic/claude-3.5-haiku")
    expect(haiku.modelData.name).toBe("Claude 3.5 Haiku")
  })

  it("returns empty map for unmapped provider", () => {
    const results = resolveProviderModels(testData, testConfig, "nonexistent")
    expect(results.size).toBe(0)
  })
})

describe("resolveModel with isolated fixture data", () => {
  it("resolves multi-model mappings from isolated fixture data", () => {
    const fixtureData: ModelsDevData = {
      "opencode-go": {
        id: "opencode-go",
        name: "OpenCode Go",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "gpt-5.4": {
            id: "gpt-5.4",
            name: "GPT-5.4",
            family: "gpt",
            attachment: true,
            reasoning: true,
            tool_call: true,
            release_date: "2025-08-31",
            last_updated: "2025-08-31",
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            open_weights: false,
            cost: { input: 2.5, output: 15, cache_read: 0.25 },
            limit: { context: 1050000, input: 922000, output: 128000 },
          },
          "mimo-v2-flash": {
            id: "mimo-v2-flash",
            name: "Mimo V2 Flash",
            family: "mimo",
            attachment: true,
            reasoning: true,
            tool_call: true,
            release_date: "2025-09-01",
            last_updated: "2025-09-01",
            modalities: { input: ["text"], output: ["text"] },
            open_weights: false,
            limit: { context: 32000, output: 4096 },
          },
        },
      },
    }

    const userConfig: AutoModelConfig = {
      mapping: {
        "misaka-newapi": {
          "gpt-5.4": "opencode-go/gpt-5.4",
          "mimo-v2-flash": "opencode-go/mimo-v2-flash",
        },
      },
    }

    const results = resolveProviderModels(fixtureData, userConfig, "misaka-newapi")
    expect(results.size).toBe(2)

    const gpt = results.get("gpt-5.4")!
    expect(gpt.warning).toBeUndefined()
    expect(gpt.modelData.name).toBe("GPT-5.4")
    expect(gpt.modelData.limit.context).toBe(1050000)
    expect(gpt.filledFields).toContain("capabilities")
    expect(gpt.filledFields).toContain("limit")

    const mimo = results.get("mimo-v2-flash")!
    expect(mimo.warning).toBeUndefined()
    expect(mimo.modelData.name).toBe("Mimo V2 Flash")
    expect(mimo.modelData.family).toBe("mimo")
  })

  it("does not silently pass when models.dev data is empty (no implicit user cache fallback)", () => {
    // resolver 是纯函数：缺少 models.dev 数据时必须显式返回 warning 且零填充，
    // 绝不能静默回退到真实用户缓存或产生无断言的通过。
    const result = resolveModel({}, testConfig, "misaka-newapi", "gpt-5.4")
    expect(result).not.toBeNull()
    expect(result!.warning).toContain("not found")
    expect(result!.filledFields).toHaveLength(0)
    expect(result!.modelData).toEqual({})
  })
})
