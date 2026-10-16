import { describe, it, expect } from "vitest"
import { fieldsFromModelsDev, getFillableFields } from "../src/utils/fields-mapper"
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

describe("fieldsFromModelsDev", () => {
  it("fills all standard V2 fields from a complete model entry", () => {
    const result = fieldsFromModelsDev(makeModel())

    expect(result.name).toBe("GPT-4o")
    expect(result.family).toBe("gpt")
    expect(result.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    })
    expect(result.limit).toEqual({ context: 128000, output: 16384 })
    expect(result.cost).toEqual([
      {
        input: 2.5,
        output: 10,
        cache: {
          read: 1.25,
          write: 3.75,
        },
      },
      {
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
      },
    ])
  })

  it("handles missing family gracefully", () => {
    const result = fieldsFromModelsDev(makeModel({ family: undefined }))
    expect(result.family).toBeUndefined()
  })

  it("includes input limit only when different from context", () => {
    const same = fieldsFromModelsDev(makeModel({ limit: { context: 128000, output: 16384, input: 128000 } }))
    expect(same.limit!.input).toBeUndefined()

    const different = fieldsFromModelsDev(makeModel({ limit: { context: 1050000, output: 128000, input: 922000 } }))
    expect(different.limit!.input).toBe(922000)
  })

  it("handles missing cost gracefully", () => {
    const result = fieldsFromModelsDev(makeModel({ cost: undefined }))
    expect(result.cost).toBeUndefined()
  })
})

describe("getFillableFields", () => {
  it("returns the list of V2 fields that can be auto-filled", () => {
    const fields = getFillableFields()
    expect(fields).toContain("name")
    expect(fields).toContain("family")
    expect(fields).toContain("capabilities")
    expect(fields).toContain("limit")
    expect(fields).toContain("cost")
  })
})
