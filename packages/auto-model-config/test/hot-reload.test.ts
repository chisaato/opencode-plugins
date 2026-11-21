import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import * as watching from "node:fs"
import path from "node:path"
import os from "node:os"
import { Model } from "@opencode/plugin"
import { setupPlugin } from "./helpers/plugin"
import { ModelsDevCache } from "../src/cache/models-dev-cache"
import { getGlobalConfigDir } from "../src/utils/paths"
import type { ModelsDevData } from "../src/types"

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    watchFile: vi.fn(original.watchFile),
    unwatchFile: vi.fn(original.unwatchFile),
  }
})

describe("模型列表配置热重载", () => {
  let root: string
  let project: string
  let cachePath: string
  let configPath: string
  let transform: (editor: any) => void
  let model: any
  let cleanup: (() => unknown) | void
  let reload: ReturnType<typeof vi.fn>

  const data = {
    source: {
      id: "source", name: "Source", npm: "test", env: [],
      models: Object.fromEntries([1, 2].map((n) => [String(n), {
        id: String(n), name: `Model ${n}`, cost: { input: n, output: n * 2 },
        limit: { context: n * 1000, output: n * 100 },
      }])),
    },
  } as unknown as ModelsDevData

  function apply() {
    // 模拟宿主 reload 从干净的默认模型重新执行同步 transform。
    model = Model.Info.default("custom" as any, "model" as any)
    expect(transform({
      provider: { get: () => ({ id: "custom" }) },
      get: () => model,
      update: (_provider: string, _id: string, update: (m: any) => void) => update(model),
    })).toBeUndefined()
  }

  async function write(file = configPath, target = "1") {
    await fs.writeFile(file, JSON.stringify({
      cachePath, mapping: { custom: { model: `source/${target}` } },
    }))
  }

  async function start() {
    cleanup = await setupPlugin({
      location: { directory: project },
      model: {
        transform: (callback: typeof transform) => { transform = callback },
        reload,
      },
    } as any) as typeof cleanup
    apply()
  }

  async function eventually(assert: () => void) {
    await vi.waitFor(assert, { timeout: 4000, interval: 25 })
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-hot-reload-"))
    project = path.join(root, "project")
    cachePath = path.join(root, "models-dev.json")
    configPath = path.join(project, "oc-auto-model-config.json")
    await fs.mkdir(project)
    await fs.writeFile(cachePath, JSON.stringify({ _fetchedAt: Date.now(), data }))
    reload = vi.fn(async () => apply())
  })

  afterEach(async () => {
    await cleanup?.()
    await fs.rm(root, { recursive: true, force: true })
  })

  it("修改与原子替换后同步更新 name/cost/limit；删除和语义空配置清除增强", async () => {
    await write()
    await start()
    expect(model.name).toBe("Model 1")
    await write(`${configPath}.tmp`, "2")
    await fs.rename(`${configPath}.tmp`, configPath)
    await eventually(() => {
      expect(model.name).toBe("Model 2")
      expect(model.cost[0].input).toBe(2)
      expect(model.limit).toEqual({ context: 2000, output: 200 })
    })
    await fs.unlink(configPath)
    await eventually(() => expect(model.name).toBe("model"))
    await write()
    await eventually(() => expect(model.name).toBe("Model 1"))
    await fs.writeFile(configPath, '{"mapping":{},"costMapping":{}}')
    await eventually(() => expect(model).toEqual(Model.Info.default("custom" as any, "model" as any)))
  })

  it("无配置也注册 transform，能发现后续创建的全局目录，保持项目/jsonc/json 优先级", async () => {
    const globalDir = getGlobalConfigDir()
    await start()
    expect(model.name).toBe("model")
    await expect(fs.stat(globalDir)).rejects.toMatchObject({ code: "ENOENT" })
    await fs.mkdir(globalDir, { recursive: true })
    const globalJson = path.join(globalDir, "oc-auto-model-config.json")
    const globalJsonc = `${globalJson}c`
    await write(globalJson)
    await eventually(() => expect(model.name).toBe("Model 1"))
    await write(globalJsonc, "2")
    await eventually(() => expect(model.name).toBe("Model 2"))
    await write()
    await eventually(() => expect(model.name).toBe("Model 1"))
    await write(`${configPath}c`, "2")
    await eventually(() => expect(model.name).toBe("Model 2"))
    await fs.unlink(`${configPath}c`)
    await eventually(() => expect(model.name).toBe("Model 1"))
    // 空的项目 jsonc 屏蔽低优先级配置。
    await fs.writeFile(`${configPath}c`, "{}")
    await eventually(() => expect(model.name).toBe("model"))
  })

  it("数据读取失败保留安全快照，下一次配置修改可恢复", async () => {
    await write()
    await start()
    const get = vi.spyOn(ModelsDevCache.prototype, "get").mockRejectedValue(new Error("offline"))
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await write(configPath, "2")
    await eventually(() => expect(errors).toHaveBeenCalled())
    expect(model.name).toBe("Model 1")
    get.mockRestore()
    await write(configPath, "2")
    await eventually(() => expect(model.name).toBe("Model 2"))
  })

  it("合并突发事件，串行刷新且不发布旧结果；cleanup 取消监听与在途发布", async () => {
    const listeners = new Map<string, () => void>()
    vi.spyOn(watching, "watchFile").mockImplementation(((file: string, _options: unknown, listener: () => void) => {
      listeners.set(file, listener)
    }) as any)
    const unwatch = vi.spyOn(watching, "unwatchFile").mockImplementation(() => {})
    unwatch.mockClear()
    await write()
    await start()
    const changed = listeners.get(configPath)!
    let release!: (value: ModelsDevData) => void
    const get = vi.spyOn(ModelsDevCache.prototype, "get")
    get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await write(configPath, "2")
    changed(); changed(); changed()
    await eventually(() => expect(get).toHaveBeenCalledTimes(1))
    await write(configPath, "1")
    changed(); changed()
    release(data)
    // 初始 refresh 后 setup 会主动 reload 一次（让后续插件的 transform 读到填充值），
    // 因此这里是第 2 次 reload：等待合并后的刷新完成。
    await eventually(() => expect(reload).toHaveBeenCalledTimes(2))
    expect(get).toHaveBeenCalledTimes(2)
    expect(model.name).toBe("Model 1")
    get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    changed()
    await eventually(() => expect(get).toHaveBeenCalledTimes(3))
    await cleanup?.()
    expect(unwatch).toHaveBeenCalledTimes(4)
    release(data)
    await new Promise((resolve) => setTimeout(resolve, 150))
    // 初始 reload(1) + 合并刷新后的 reload(2)；cleanup 已取消监听且 dispose 掉在途刷新。
    expect(reload).toHaveBeenCalledTimes(2)
    // 已经捕获的 transform 也不会在 dispose 后增强模型。
    apply()
    expect(model.name).toBe("model")
    cleanup = undefined
  })
})
