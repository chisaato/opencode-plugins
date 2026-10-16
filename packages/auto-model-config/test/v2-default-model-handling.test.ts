import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AutoModelConfigPlugin } from "../src/index"
import { Model } from "@opencode/plugin"
import type { ModelsDevData } from "../src/types"

describe("V2 default model vs explicit user overrides", () => {
  const testRoot = path.join(os.tmpdir(), "oc-default-model-test-" + Date.now())
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
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
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
          "my-provider": {
            "default-gpt4o": "openai/gpt-4o",
            "custom-gpt4o": "openai/gpt-4o",
            "explicit-gpt4o": "openai/gpt-4o",
            "partial-gpt4o": "openai/gpt-4o",
          },
        },
      }),
    )
  })

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  function makeEditor(fakeModels: Record<string, any>) {
    return {
      provider: {
        get(providerID: string) {
          if (providerID === "my-provider") return { id: providerID }
          return undefined
        },
      },
      get(providerID: string, modelID: string) {
        if (providerID === "my-provider") return fakeModels[modelID]
        return undefined
      },
      update(providerID: string, modelID: string, updater: (m: any) => void) {
        if (providerID === "my-provider" && fakeModels[modelID]) {
          updater(fakeModels[modelID])
        }
      },
    }
  }

  function makeCtx() {
    let transformCallback: ((editor: any) => void) | undefined
    const ctx: any = {
      location: { directory: projectDir },
      model: {
        transform: async (cb: (editor: any) => void) => {
          transformCallback = cb
        },
      },
    }
    return { ctx, getTransform: () => transformCallback }
  }

  it("fills real Model.Info.default fields and preserves explicit user overrides for name/limit/capabilities/cost/family", async () => {
    // 1. 真实 Model.Info.default 构造的默认模型（代表用户在 opencode.json 中只写了 "default-gpt4o": {}）
    const defaultModel = Model.Info.default("my-provider" as any, "default-gpt4o" as any)

    // 2. 用户明确提供部分覆盖字段的模型（如 explicit name, explicit limit）
    const userModel: any = Model.Info.default("my-provider" as any, "custom-gpt4o" as any)
    userModel.name = "My Handcrafted GPT-4o Name"
    userModel.limit = { context: 64000, output: 8000 }

    // 3. 用户对所有可填充字段都显式覆盖的模型
    const explicitModel: any = Model.Info.default("my-provider" as any, "explicit-gpt4o" as any)
    explicitModel.name = "Explicit Handcrafted Name"
    explicitModel.family = "explicit-family"
    explicitModel.limit = { context: 12345, output: 678 }
    explicitModel.capabilities = { tools: false, input: ["audio"], output: ["audio"] }
    explicitModel.cost = [{ input: 9, output: 9, cache: { read: 9, write: 9 } }]

    const fakeModels: Record<string, any> = {
      "default-gpt4o": defaultModel,
      "custom-gpt4o": userModel,
      "explicit-gpt4o": explicitModel,
    }

    const { ctx, getTransform } = makeCtx()
    await AutoModelConfigPlugin.setup(ctx)
    const transformCallback = getTransform()
    expect(transformCallback).toBeDefined()
    transformCallback!(makeEditor(fakeModels))

    // 针对 defaultModel:
    // 即使 default 默认 name 为 "default-gpt4o"，因为未显式覆盖，应该被填充为 models.dev 的 "GPT-4o Official"
    expect(fakeModels["default-gpt4o"].name).toBe("GPT-4o Official")
    expect(fakeModels["default-gpt4o"].family).toBe("gpt")
    // 默认 limit 为 200_000/32_000，未显式覆盖，应被填充为 128000/16384
    expect(fakeModels["default-gpt4o"].limit).toEqual({ context: 128000, output: 16384 })
    // 默认 capabilities 为 Capabilities.default()，输入应填入 models.dev 的 pdf
    expect(fakeModels["default-gpt4o"].capabilities.input).toEqual(["text", "image", "pdf"])
    // 默认 cost 为 []，应被填充
    expect(fakeModels["default-gpt4o"].cost).toHaveLength(1)

    // 针对 userModel:
    // 显式提供的 name 和 limit 必须原样保留
    expect(fakeModels["custom-gpt4o"].name).toBe("My Handcrafted GPT-4o Name")
    expect(fakeModels["custom-gpt4o"].limit).toEqual({ context: 64000, output: 8000 })
    // 未显式覆盖的 family 和 cost 依然被自动填充
    expect(fakeModels["custom-gpt4o"].family).toBe("gpt")
    expect(fakeModels["custom-gpt4o"].cost).toHaveLength(1)

    // 针对 explicitModel: 五个字段全部显式设置，必须一个都不能被覆盖
    expect(fakeModels["explicit-gpt4o"].name).toBe("Explicit Handcrafted Name")
    expect(fakeModels["explicit-gpt4o"].family).toBe("explicit-family")
    expect(fakeModels["explicit-gpt4o"].limit).toEqual({ context: 12345, output: 678 })
    expect(fakeModels["explicit-gpt4o"].capabilities).toEqual({
      tools: false,
      input: ["audio"],
      output: ["audio"],
    })
    expect(fakeModels["explicit-gpt4o"].cost).toEqual([
      { input: 9, output: 9, cache: { read: 9, write: 9 } },
    ])
  })

  it("fills remaining default leaves when the user only partially overrides limit/capabilities without overwriting explicit leaves", async () => {
    // OpenCode 宿主会把用户显式配置的叶子合并到 Model.Info.default 上：
    // 这里只显式覆盖 limit.output 与 capabilities.tools，其余叶子仍是默认值。
    const partialModel: any = Model.Info.default("my-provider" as any, "partial-gpt4o" as any)
    partialModel.limit = { ...partialModel.limit, output: 8000 }
    partialModel.capabilities = { ...partialModel.capabilities, tools: false }

    const fakeModels: Record<string, any> = { "partial-gpt4o": partialModel }

    const { ctx, getTransform } = makeCtx()
    await AutoModelConfigPlugin.setup(ctx)
    const transformCallback = getTransform()
    expect(transformCallback).toBeDefined()
    transformCallback!(makeEditor(fakeModels))

    // limit.output 为用户显式值，必须保留；limit.context 仍等于默认值，必须被填充
    expect(fakeModels["partial-gpt4o"].limit).toEqual({ context: 128000, output: 8000 })
    // capabilities.tools 为用户显式值，必须保留；input/output 仍等于默认空数组，必须被填充
    expect(fakeModels["partial-gpt4o"].capabilities).toEqual({
      tools: false,
      input: ["text", "image", "pdf"],
      output: ["text"],
    })
    // name 未覆盖，应被填充
    expect(fakeModels["partial-gpt4o"].name).toBe("GPT-4o Official")
  })

  it("derives fill decisions from the live Model.Info.default shape instead of hardcoded constants", async () => {
    const originalDefault = Model.Info.default
    try {
      // 模拟 OpenCode 未来版本修改了 Model.Info.default 的初始值：
      // 硬编码 200000/32000、modelID name 的实现会把这些“新默认值”误判为用户显式覆盖而跳过填充；
      // 动态读取 Model.Info.default 的实现则应识别为默认值并正常填充。
      ;(Model.Info as any).default = (providerID: any, id: any): any => ({
        ...(originalDefault as any)(providerID, id),
        name: `OPENCODE-DEFAULT:${String(id)}`,
        limit: { context: 999_000, output: 111 },
        capabilities: { tools: false, input: ["text"], output: ["text"] },
        cost: [],
      })

      const liveDefaultModel: any = Model.Info.default("my-provider" as any, "default-gpt4o" as any)
      const fakeModels: Record<string, any> = { "default-gpt4o": liveDefaultModel }

      const { ctx, getTransform } = makeCtx()
      await AutoModelConfigPlugin.setup(ctx)
      const transformCallback = getTransform()
      expect(transformCallback).toBeDefined()
      transformCallback!(makeEditor(fakeModels))

      expect(liveDefaultModel.name).toBe("GPT-4o Official")
      expect(liveDefaultModel.limit).toEqual({ context: 128000, output: 16384 })
      expect(liveDefaultModel.capabilities.input).toEqual(["text", "image", "pdf"])
      expect(liveDefaultModel.cost).toHaveLength(1)
    } finally {
      ;(Model.Info as any).default = originalDefault
    }
  })

  it("force overrides cost when override.cost is true even if user provided explicit cost", async () => {
    // 覆盖配置文件以启用 override.cost: true
    await fs.writeFile(
      path.join(projectDir, "oc-auto-model-config.json"),
      JSON.stringify({
        mapping: {
          "my-provider": {
            "explicit-gpt4o": "openai/gpt-4o",
          },
        },
        override: {
          cost: true,
        },
      }),
    )

    const explicitModel: any = Model.Info.default("my-provider" as any, "explicit-gpt4o" as any)
    explicitModel.name = "Explicit Handcrafted Name"
    explicitModel.family = "explicit-family"
    explicitModel.limit = { context: 12345, output: 678 }
    explicitModel.cost = [{ input: 999, output: 999, cache: { read: 999, write: 999 } }]

    const fakeModels: Record<string, any> = {
      "explicit-gpt4o": explicitModel,
    }

    const { ctx, getTransform } = makeCtx()
    await AutoModelConfigPlugin.setup(ctx)
    const transformCallback = getTransform()
    expect(transformCallback).toBeDefined()
    transformCallback!(makeEditor(fakeModels))

    // 其它显式配置的字段依然不被覆盖
    expect(fakeModels["explicit-gpt4o"].name).toBe("Explicit Handcrafted Name")
    expect(fakeModels["explicit-gpt4o"].family).toBe("explicit-family")
    expect(fakeModels["explicit-gpt4o"].limit).toEqual({ context: 12345, output: 678 })

    // cost 字段被 models.dev 的 cost 强制覆盖
    expect(fakeModels["explicit-gpt4o"].cost).toEqual([
      {
        input: 2.5,
        output: 10,
        cache: {
          read: 1.25,
          write: 0,
        },
      },
    ])
  })
})
