import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AutoModelConfigPlugin } from "../src/index"
import type { ModelsDevData } from "../src/types"

describe("V2 transform editor integration", () => {
  const testRoot = path.join(os.tmpdir(), "oc-transform-test-" + Date.now())
  const projectDir = path.join(testRoot, "project")
  const cachePath = path.join(testRoot, "models-dev.json")

  const fakeModelsDevData: ModelsDevData = {
    openai: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: [],
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          name: "GPT-4o Official",
          family: "gpt",
          attachment: true,
          reasoning: false,
          tool_call: true,
          release_date: "2024-05-13",
          last_updated: "2024-08-06",
          modalities: { input: ["text", "image"], output: ["text"] },
          open_weights: false,
          cost: { input: 2.5, output: 10, cache_read: 1.25 },
          limit: { context: 128000, output: 16384 },
        },
      },
    },
  }

  beforeEach(async () => {
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(
      cachePath,
      JSON.stringify({ _fetchedAt: Date.now(), data: fakeModelsDevData }),
    )
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({
        cachePath,
        mapping: {
          "custom-provider": {
            "my-gpt4o": "openai/gpt-4o",
            "missing-model": "openai/non-existent",
          },
        },
      }),
    )
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  it("registers transform, fills existing model metadata without overwriting user explicit fields", async () => {
    let transformCallback: ((editor: any) => void) | undefined

    const fakeModels: Record<string, any> = {
      "my-gpt4o": {
        name: "User Custom Name", // Explicit user value
      },
      "other-unmapped": {
        name: "Keep Untouched",
      },
    }

    const mockEditor = {
      provider: {
        get(providerID: string) {
          if (providerID === "custom-provider") return { id: providerID }
          return undefined
        },
      },
      get(providerID: string, modelID: string) {
        if (providerID === "custom-provider") return fakeModels[modelID]
        return undefined
      },
      update(providerID: string, modelID: string, updater: (m: any) => void) {
        if (providerID === "custom-provider" && fakeModels[modelID]) {
          updater(fakeModels[modelID])
        }
      },
    }

    const mockCtx: any = {
      location: {
        directory: projectDir,
      },
      model: {
        transform: async (cb: (editor: any) => void) => {
          transformCallback = cb
        },
      },
    }

    await AutoModelConfigPlugin.setup(mockCtx)

    expect(transformCallback).toBeDefined()
    transformCallback!(mockEditor)

    // User custom name preserved
    expect(fakeModels["my-gpt4o"].name).toBe("User Custom Name")
    // Auto-filled V2 fields
    expect(fakeModels["my-gpt4o"].family).toBe("gpt")
    expect(fakeModels["my-gpt4o"].capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    })
    expect(fakeModels["my-gpt4o"].limit).toEqual({
      context: 128000,
      output: 16384,
    })
    expect(fakeModels["my-gpt4o"].cost).toEqual([
      {
        input: 2.5,
        output: 10,
        cache: {
          read: 1.25,
          write: 0,
        },
      },
    ])

    // Other models untouched
    expect(fakeModels["other-unmapped"]).toEqual({
      name: "Keep Untouched",
    })
  })

  it("safely skips when provider or model does not exist in editor", async () => {
    let transformCallback: ((editor: any) => void) | undefined
    const mockEditor = {
      provider: {
        get(_providerID: string) {
          return undefined // Provider does not exist in editor
        },
      },
      get(_providerID: string, _modelID: string) {
        return undefined
      },
      update: () => {
        throw new Error("Should not be called")
      },
    }

    const mockCtx: any = {
      location: {
        directory: projectDir,
      },
      model: {
        transform: async (cb: (editor: any) => void) => {
          transformCallback = cb
        },
      },
    }

    await AutoModelConfigPlugin.setup(mockCtx)
    expect(transformCallback).toBeDefined()
    expect(() => transformCallback!(mockEditor)).not.toThrow()
  })
})
