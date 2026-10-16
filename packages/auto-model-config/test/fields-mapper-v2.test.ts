import { describe, it, expect } from "vitest"
import { fieldsFromModelsDev } from "../src/utils/fields-mapper"
import type { ModelsDevModel } from "../src/types"

function makeModel(overrides: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    family: "gpt",
    attachment: true,
    reasoning: false,
    tool_call: true,
    structured_output: true,
    temperature: true,
    knowledge: "2023-10",
    release_date: "2024-05-13",
    last_updated: "2024-08-06",
    modalities: { input: ["text", "image"], output: ["text"] },
    open_weights: false,
    cost: {
      input: 2.5,
      output: 10,
      cache_read: 1.25,
      cache_write: 3.75,
      context_over_200k: {
        input: 5.0,
        output: 20.0,
        cache_read: 2.5,
      },
    },
    limit: { context: 128000, output: 16384 },
    ...overrides,
  }
}

describe("fieldsFromModelsDev V2 mapping", () => {
  it("maps capabilities with tools and input/output modalities", () => {
    const result = fieldsFromModelsDev(makeModel({ tool_call: true, modalities: { input: ["text", "image"], output: ["text"] } }))
    expect(result.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    })
    // Ensure V1 fields are not on the root
    const root = result as unknown as Record<string, unknown>
    expect(root.tool_call).toBeUndefined()
    expect(root.modalities).toBeUndefined()
    expect(root.attachment).toBeUndefined()
  })

  it("maps family when present", () => {
    const withFamily = fieldsFromModelsDev(makeModel({ family: "gpt" }))
    expect(withFamily.family).toBe("gpt")

    const withoutFamily = fieldsFromModelsDev(makeModel({ family: undefined }))
    expect(withoutFamily.family).toBeUndefined()
  })

  it("maps limit context and output, plus input when different", () => {
    const res = fieldsFromModelsDev(makeModel({ limit: { context: 1050000, input: 922000, output: 128000 } }))
    expect(res.limit).toEqual({
      context: 1050000,
      input: 922000,
      output: 128000,
    })
  })

  it("maps cost to V2 array format including base cost and context_over_200k tier", () => {
    const res = fieldsFromModelsDev(makeModel())
    expect(Array.isArray(res.cost)).toBe(true)
    expect(res.cost).toHaveLength(2)

    // Base cost
    expect(res.cost![0]).toEqual({
      input: 2.5,
      output: 10,
      cache: {
        read: 1.25,
        write: 3.75,
      },
    })

    // 200k tier
    expect(res.cost![1]).toEqual({
      tier: {
        type: "context",
        size: 200000,
      },
      input: 5.0,
      output: 20.0,
      cache: {
        read: 2.5,
        write: 0,
      },
    })
  })
})
