import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AutoModelConfigPlugin } from "../src/index"
import { Model } from "@opencode/plugin"
import type { ModelsDevData } from "../src/types"

/**
 * 这是针对 V2 `Plugin.define` / `ModelEditor` 契约的 adapter 集成测试，
 * 使用内存中的 mock editor 驱动 transform 回调。它不是端到端 smoke，
 * 也不会启动真实 OpenCode CLI。
 *
 * 真实、隔离、环境变量门控的 CLI smoke 见 `test/smoke/opencode-cli.smoke.ts`。
 */
describe("V2 Adapter / Host Contract Integration (mocked ModelEditor)", () => {
  const testRoot = path.join(os.tmpdir(), "oc-adapter-integration-" + Date.now())
  const projectDir = path.join(testRoot, "project")
  const cachePath = path.join(projectDir, "models-dev.json")

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
          "adapter-provider": {
            "adapter-gpt4o": "openai/gpt-4o",
          },
        },
      }),
    )
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  it("registers a transform and applies V2 fields through a mocked ModelEditor", async () => {
    let registeredTransform: ((editor: any) => void) | undefined

    // 使用真实 Model.Info.default 构造的模型，代表用户在 opencode.json 中只写了 "adapter-gpt4o": {}
    const modelInfo = Model.Info.default(
      "adapter-provider" as any,
      "adapter-gpt4o" as any,
    )

    const hostContext: any = {
      app: {},
      location: { directory: projectDir },
      options: {},
      model: {
        transform: async (cb: any) => {
          registeredTransform = cb
          return { dispose: async () => {} }
        },
      },
    }

    // 执行 setup
    await AutoModelConfigPlugin.setup(hostContext)
    expect(registeredTransform).toBeDefined()

    // 模拟 V2 editor 触发
    const editorModels: Record<string, any> = {
      "adapter-gpt4o": modelInfo,
    }

    const mockEditor = {
      provider: {
        get(providerID: string) {
          return providerID === "adapter-provider" ? { id: providerID } : undefined
        },
      },
      get(providerID: string, modelID: string) {
        if (providerID === "adapter-provider") return editorModels[modelID]
        return undefined
      },
      update(providerID: string, modelID: string, updater: (m: any) => void) {
        if (providerID === "adapter-provider" && editorModels[modelID]) {
          updater(editorModels[modelID])
        }
      },
    }

    registeredTransform!(mockEditor)

    const updated = editorModels["adapter-gpt4o"]
    expect(updated.name).toBe("GPT-4o Official")
    expect(updated.family).toBe("gpt")
    expect(updated.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    })
    expect(updated.limit).toEqual({
      context: 128000,
      output: 16384,
    })
    expect(updated.cost).toHaveLength(2)
    expect(updated.cost[0]).toEqual({
      input: 2.5,
      output: 10,
      cache: { read: 1.25, write: 3.75 },
    })
    expect(updated.cost[1]).toEqual({
      tier: { type: "context", size: 200000 },
      input: 5.0,
      output: 20.0,
      cache: { read: 2.5, write: 0 },
    })
  })
})
