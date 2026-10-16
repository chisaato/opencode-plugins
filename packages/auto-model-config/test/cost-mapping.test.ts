import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AutoModelConfigPlugin } from "../src/index"
import type { ModelsDevData } from "../src/types"

describe("costMapping red", () => {
  const testRoot = path.join(os.tmpdir(), "oc-cost-mapping-red-" + Date.now())
  const projectDir = path.join(testRoot, "project")
  const cachePath = path.join(testRoot, "models-dev.json")

  const fakeModelsDevData: ModelsDevData = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: [],
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          attachment: false,
          reasoning: true,
          tool_call: true,
          release_date: "2026-02-17",
          last_updated: "2026-02-17",
          modalities: { input: ["text", "image"], output: ["text"] },
          open_weights: false,
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          limit: { context: 200000, output: 64000 },
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
        costMapping: {
          "claude-code": {
            "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
          },
        },
      }),
    )
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  it("applies costMapping without mapping and only replaces cost", async () => {
    let transformCallback: ((editor: any) => void) | undefined

    const model = {
      id: "claude-sonnet-4-6",
      modelID: "claude-sonnet-4-6",
      providerID: "claude-code",
      name: "Keep Name",
      family: "keep-family",
      limit: { context: 111, output: 222 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
    }

    const mockEditor = {
      list() {
        throw new Error("costMapping must not scan editor.list()")
      },
      provider: {
        get(providerID: string) {
          if (providerID === "claude-code") return { id: providerID }
          return undefined
        },
      },
      get(providerID: string, modelID: string) {
        if (providerID === "claude-code" && modelID === "claude-sonnet-4-6") return model
        return undefined
      },
      update(providerID: string, modelID: string, updater: (m: any) => void) {
        if (providerID === "claude-code" && modelID === "claude-sonnet-4-6") updater(model)
      },
    }

    const mockCtx: any = {
      location: { directory: projectDir },
      model: {
        transform: async (cb: (editor: any) => void) => {
          transformCallback = cb
        },
      },
    }

    await AutoModelConfigPlugin.setup(mockCtx)
    expect(transformCallback).toBeDefined()
    transformCallback!(mockEditor)

    expect(model.cost).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    ])
    expect(model.name).toBe("Keep Name")
    expect(model.family).toBe("keep-family")
    expect(model.limit).toEqual({ context: 111, output: 222 })
    expect(model.capabilities).toEqual({ tools: false, input: ["text"], output: ["text"] })
    expect(model.status).toBe("active")
  })
})

describe("costMapping regressions", () => {
  const testRoot = path.join(os.tmpdir(), "oc-cost-mapping-reg-" + Date.now())
  const projectDir = path.join(testRoot, "project")
  const cachePath = path.join(testRoot, "models-dev.json")
  const dumpPath = path.join(testRoot, "dump.json")

  const tieredCost = {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
    context_over_200k: { input: 6, output: 22.5, cache_read: 0.6 },
  }
  const expectedBase = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]
  const expectedTiered = [
    ...expectedBase,
    {
      tier: { type: "context", size: 200000 },
      input: 6,
      output: 22.5,
      cache: { read: 0.6, write: 0 },
    },
  ]

  function modelEntry(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      name: id,
      attachment: false,
      reasoning: false,
      tool_call: true,
      release_date: "2026-01-01",
      last_updated: "2026-01-01",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: false,
      limit: { context: 200000, output: 64000 },
      ...overrides,
    }
  }

  const fakeModelsDevData: ModelsDevData = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: [],
      models: {
        "claude-sonnet-4-6": modelEntry("claude-sonnet-4-6", { cost: tieredCost, name: "Claude Sonnet 4.6" }),
        "claude-haiku-4-5": modelEntry("claude-haiku-4-5", { name: "Haiku without price" }),
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: [],
      models: {
        "gpt-4o": modelEntry("gpt-4o", {
          name: "GPT-4o Official",
          family: "gpt",
          cost: { input: 2.5, output: 10, cache_read: 1.25 },
          limit: { context: 128000, output: 16384 },
          modalities: { input: ["text", "image"], output: ["text"] },
        }),
      },
    },
    "alibaba-cn": {
      id: "alibaba-cn",
      name: "Alibaba CN",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "qwen3-max": modelEntry("qwen3-max", {
          name: "Qwen3 Max",
          cost: { input: 0.359, output: 1.434 },
        }),
      },
    },
  }

  beforeEach(async () => {
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify({ _fetchedAt: Date.now(), data: fakeModelsDevData }))
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  function editorFor(models: Record<string, Record<string, any>>, listCalls: { n: number }) {
    return {
      list() {
        listCalls.n++
        throw new Error("costMapping must not scan editor.list()")
      },
      provider: {
        get(providerID: string) {
          return models[providerID] ? { id: providerID } : undefined
        },
      },
      get(providerID: string, modelID: string) {
        return models[providerID]?.[modelID]
      },
      update(providerID: string, modelID: string, updater: (m: any) => void) {
        const model = models[providerID]?.[modelID]
        if (model) updater(model)
      },
    }
  }

  async function run(config: Record<string, unknown>, models: Record<string, Record<string, any>>) {
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({ cachePath, ...config }),
    )
    let transformCallback: ((editor: any) => void) | undefined
    const listCalls = { n: 0 }
    const ctx: any = {
      location: { directory: projectDir },
      model: {
        transform: async (cb: (editor: any) => void) => {
          transformCallback = cb
        },
      },
    }
    await AutoModelConfigPlugin.setup(ctx)
    expect(transformCallback).toBeDefined()
    transformCallback!(editorFor(models, listCalls))
    expect(listCalls.n).toBe(0)
    return transformCallback
  }

  function priced(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      modelID: id,
      name: "Keep Name",
      family: "keep-family",
      limit: { context: 111, output: 222 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      ...extra,
    }
  }

  it("does not price unlisted models, including the same id on openrouter", async () => {
    const listed = priced("claude-sonnet-4-6")
    const openrouter = priced("claude-sonnet-4-6", { providerID: "openrouter" })
    const future = priced("claude-opus-9")
    await run(
      { costMapping: { "claude-code": { "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6" } } },
      {
        "claude-code": { "claude-sonnet-4-6": listed, "claude-opus-9": future },
        openrouter: { "claude-sonnet-4-6": openrouter },
      },
    )
    expect(listed.cost).toEqual(expectedTiered)
    expect(openrouter.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(future.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(openrouter.name).toBe("Keep Name")
  })

  it("leaves well-known-looking models alone when costMapping is absent", async () => {
    const claude = priced("claude-sonnet-4-6")
    const custom = { name: "User Custom Name" }
    await run(
      { mapping: { "custom-provider": { "my-gpt4o": "openai/gpt-4o" } } },
      {
        "claude-code": { "claude-sonnet-4-6": claude },
        "custom-provider": { "my-gpt4o": custom },
      },
    )
    expect(claude.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(claude.name).toBe("Keep Name")
    expect(custom.name).toBe("User Custom Name")
    expect((custom as any).family).toBe("gpt")
    expect((custom as any).cost).toEqual([{ input: 2.5, output: 10, cache: { read: 1.25, write: 0 } }])
  })

  it("lets costMapping win on cost after mapping, without needing override.cost", async () => {
    const model = {
      name: "Explicit Name",
      family: "explicit-family",
      limit: { context: 9, output: 8 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      cost: [{ input: 999, output: 999, cache: { read: 999, write: 999 } }],
      status: "beta",
    }
    await run(
      {
        mapping: { "claude-code": { "claude-sonnet-4-6": "openai/gpt-4o" } },
        costMapping: { "claude-code": { "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6" } },
        override: { cost: false },
      },
      { "claude-code": { "claude-sonnet-4-6": model } },
    )
    expect(model.name).toBe("Explicit Name")
    expect(model.family).toBe("explicit-family")
    expect(model.limit).toEqual({ context: 9, output: 8 })
    expect(model.status).toBe("beta")
    expect(model.cost).toEqual(expectedTiered)
  })

  it("still applies mapping metadata first when override.cost is true, then replaces only cost", async () => {
    const { Model } = await import("@opencode/plugin")
    const model: any = Model.Info.default("claude-code" as any, "claude-sonnet-4-6" as any)
    await run(
      {
        mapping: { "claude-code": { "claude-sonnet-4-6": "openai/gpt-4o" } },
        costMapping: { "claude-code": { "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6" } },
        override: { cost: true },
      },
      { "claude-code": { "claude-sonnet-4-6": model } },
    )
    expect(model.name).toBe("GPT-4o Official")
    expect(model.family).toBe("gpt")
    expect(model.limit).toEqual({ context: 128000, output: 16384 })
    expect(model.cost).toEqual(expectedTiered)
  })

  it("does not invent a cost when mapping fails and the model is not in costMapping", async () => {
    const broken = priced("my-model")
    const listed = priced("claude-sonnet-4-6")
    await run(
      {
        mapping: { "custom-provider": { "my-model": "openai/does-not-exist" } },
        costMapping: { "claude-code": { "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6" } },
      },
      {
        "custom-provider": { "my-model": broken },
        "claude-code": { "claude-sonnet-4-6": listed },
      },
    )
    expect(broken.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(broken.name).toBe("Keep Name")
    expect(listed.cost).toEqual(expectedTiered)
  })

  it("copies source tiers for an explicit [1m] entry and does not strip an unmapped suffix", async () => {
    const mapped = priced("claude-sonnet-4-6[1m]")
    const unmapped = priced("claude-opus-4-6[1m]")
    await run(
      {
        costMapping: {
          "claude-code": {
            "claude-sonnet-4-6[1m]": "anthropic/claude-sonnet-4-6",
            "claude-opus-4-6[1m]": "anthropic/claude-opus-4-6[1m]",
          },
        },
      },
      {
        "claude-code": {
          "claude-sonnet-4-6[1m]": mapped,
          "claude-opus-4-6[1m]": unmapped,
        },
      },
    )
    expect(mapped.cost).toEqual(expectedTiered)
    expect(mapped.name).toBe("Keep Name")
    expect(mapped.limit).toEqual({ context: 111, output: 222 })
    expect(unmapped.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(JSON.stringify(mapped.cost)).not.toContain("1000000")
  })

  it("maps an explicitly listed coding-plan id onto the priced API model", async () => {
    const listed = priced("qwen3-max-2026-01-23")
    const sameProviderOther = priced("qwen3-coder-plus")
    await run(
      {
        costMapping: {
          "alibaba-coding-plan-cn": {
            "qwen3-max-2026-01-23": "alibaba-cn/qwen3-max",
          },
        },
      },
      {
        "alibaba-coding-plan-cn": {
          "qwen3-max-2026-01-23": listed,
          "qwen3-coder-plus": sameProviderOther,
        },
      },
    )
    expect(listed.cost).toEqual([{ input: 0.359, output: 1.434, cache: { read: 0, write: 0 } }])
    expect(listed.family).toBe("keep-family")
    expect(sameProviderOther.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  })

  it("keeps the original cost and records a dump reason when the source has no price", async () => {
    const missing = priced("claude-haiku-4-5")
    const unknown = priced("claude-sonnet-4-6")
    await run(
      {
        debug: { enabled: true, dumpPath, diffOnly: true },
        costMapping: {
          "claude-code": {
            "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
            "claude-sonnet-4-6": "anthropic/not-a-model",
            "not-in-editor": "anthropic/claude-sonnet-4-6",
          },
        },
      },
      { "claude-code": { "claude-haiku-4-5": missing, "claude-sonnet-4-6": unknown } },
    )
    expect(missing.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(unknown.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(missing.name).toBe("Keep Name")

    await vi.waitFor(async () => {
      const parsed = JSON.parse(await fs.readFile(dumpPath, "utf-8"))
      const models = parsed.provider["claude-code"].models
      expect(models["claude-haiku-4-5"]._costWarning).toContain("has no cost")
      expect(models["claude-sonnet-4-6"]._costWarning).toContain("not found")
      expect(models["not-in-editor"]._costWarning).toContain("not found in editor")
      expect(models["not-in-editor"]._skipped).toBe(true)
    })
  })
})
