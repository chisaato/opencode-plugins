import { isDeepStrictEqual } from "node:util"
import { watchFile, unwatchFile } from "node:fs"
import path from "node:path"
import { Plugin, Model } from "@opencode/plugin"
import { ModelsDevCache } from "../cache/models-dev-cache"
import { loadConfig, getMappedProviders } from "../mapping/parser"
import { resolveProviderModels } from "../mapping/resolver"
import { fieldsFromModelsDev } from "../utils/fields-mapper"
import { ConfigDumper, type EnhancedModelResult } from "../debug/config-dumper"
import { applyCostMapping } from "../cost/apply-cost-mapping"
import { getGlobalConfigDir } from "../utils/paths"
import type { AutoModelConfig, ModelsDevData, ResolvedModel } from "../types"

type PlainRecord = Record<string, unknown>

interface Snapshot {
  pluginConfig: AutoModelConfig
  modelsDev: ModelsDevData
  allResolved: Map<string, Map<string, ResolvedModel>>
  cacheAge: number
  dumper: ConfigDumper | null
}

async function loadSnapshot(projectDir: string): Promise<Snapshot | null> {
  const pluginConfig = await loadConfig({ projectDirectory: projectDir })
  if (!pluginConfig) return null
  const cache = new ModelsDevCache({
    cachePath: pluginConfig.cachePath,
    cacheTTL: pluginConfig.cacheTTL,
    projectDirectory: projectDir,
  })
  const modelsDev = await cache.get()
  if (!modelsDev) throw new Error("No models.dev data available")
  const cacheAge = await cache.getAge()
  const allResolved = new Map<string, Map<string, ResolvedModel>>()
  for (const provider of getMappedProviders(pluginConfig)) {
    allResolved.set(provider, resolveProviderModels(modelsDev, pluginConfig, provider))
  }
  const dumper = pluginConfig.debug?.enabled
    ? new ConfigDumper({ ...pluginConfig.debug, projectDirectory: projectDir })
    : null
  return { pluginConfig, modelsDev, allResolved, cacheAge, dumper }
}

/** `Model.Info.default(providerID, modelID)` 的真实参数类型（带 brand 的 Provider.ID / Model.ID）。 */
type ModelDefaultArgs = Parameters<typeof Model.Info.default>

function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断字段当前值是否仍等于 OpenCode V2 模型的初始默认值。
 *
 * 默认值完全来自实际的 `Model.Info.default(providerID, modelID)`（其内部包含实际的
 * `Model.Capabilities.default()`），不再硬编码 name/limit/cost 等常量，从而自动跟随
 * OpenCode 自身默认值的变化。
 *
 * 合并语义：
 * - 对象型默认字段（如 `limit` / `capabilities`）按**叶子**递归比较：只填充仍等于默认值
 *   或 `undefined` 的叶子，绝不覆盖用户显式设置的叶子。这样当宿主把用户的部分覆盖
 *   （例如只写了 `limit.output`）合并到默认对象上时，同一对象的其它默认叶子仍会被补齐。
 * - 数组型字段（如 `cost`）保持**整对象**语义：仅当当前数组仍等于默认值时才整体替换，
 *   避免破坏用户自建的数组（例如自定义阶梯定价）。
 * - 标量字段（如 `name` / `family`）仍按整值深度比较。
 *
 * 宿主契约假设（当前无法端到端验证）：宿主对用户未显式配置的字段暴露的值应等于
 * `Model.Info.default()` 的返回值。若宿主持有其它基底并据此预填字段，可能出现字段
 * 静默不填充；需通过 debug dump 观察实际值来确认。相关测试均为 mock ModelEditor 的
 * adapter 测试，不代表已端到端验证。
 *
 * 注意：若用户显式把某字段设置成与默认值完全相同的值（例如把 name 写成与 modelID 相同，
 * 或把 limit 写成默认的 200000/32000），则该值与初始默认值不可区分，会被视为可自动填充。
 * 这是可接受的折衷。
 */
function mergeModelField(
  defaults: PlainRecord,
  key: string,
  currentValue: unknown,
  desiredValue: unknown,
): { shouldFill: boolean; value: unknown } {
  // 未设置 → 直接填充
  if (currentValue === undefined) {
    return { shouldFill: true, value: desiredValue }
  }

  const defaultValue = key in defaults ? defaults[key] : undefined

  // 数组型字段：整对象语义，只有当前值仍等于默认值时才整体替换
  if (Array.isArray(desiredValue)) {
    if (defaultValue === undefined) {
      // 默认值中没有该字段，但用户已设置 → 用户显式值，保留
      return { shouldFill: false, value: currentValue }
    }
    return isDeepStrictEqual(currentValue, defaultValue)
      ? { shouldFill: true, value: desiredValue }
      : { shouldFill: false, value: currentValue }
  }

  // 对象型字段：按叶子递归合并
  if (isPlainObject(desiredValue)) {
    if (!isPlainObject(currentValue)) {
      // 当前值不是对象，视为用户显式设置，保持
      return { shouldFill: false, value: currentValue }
    }

    const defaultObject = isPlainObject(defaultValue) ? defaultValue : {}
    const merged: PlainRecord = { ...currentValue }
    let changed = false

    for (const [leafKey, leafDesired] of Object.entries(desiredValue)) {
      const leafDefault = leafKey in defaultObject ? defaultObject[leafKey] : undefined
      const leafCurrent = currentValue[leafKey]

      // 嵌套对象递归处理，保留用户在这一层的显式叶子
      if (isPlainObject(leafDesired)) {
        const nested = mergeModelField(defaultObject, leafKey, leafCurrent, leafDesired)
        if (nested.shouldFill) {
          merged[leafKey] = nested.value
          changed = true
        }
        continue
      }

      // 当前叶子未设置 → 填充
      if (leafCurrent === undefined) {
        merged[leafKey] = leafDesired
        changed = true
        continue
      }

      // 默认值中没有该叶子，但用户已设置 → 用户显式值，保留
      if (leafDefault === undefined) {
        continue
      }

      // 当前叶子仍等于默认值 → 填充；否则视为用户显式覆盖
      if (isDeepStrictEqual(leafCurrent, leafDefault)) {
        merged[leafKey] = leafDesired
        changed = true
      }
    }

    return changed
      ? { shouldFill: true, value: merged }
      : { shouldFill: false, value: currentValue }
  }

  // 标量字段
  if (defaultValue === undefined) {
    return { shouldFill: false, value: currentValue }
  }
  return isDeepStrictEqual(currentValue, defaultValue)
    ? { shouldFill: true, value: desiredValue }
    : { shouldFill: false, value: currentValue }
}

export const AutoModelConfigPlugin = Plugin.define({
  id: "opencode-auto-model-config",
  async setup(ctx) {
    const projectDir = ctx.location?.directory ?? process.cwd()
    let snapshot: Snapshot | null = null
    let disposed = false
    let revision = 0
    let handledRevision = -1
    let running = false
    let ready = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const report = (error: unknown) => {
      console.error("[auto-model-config] Failed to refresh models:", error)
    }
    const refresh = async (initial = false) => {
      if (disposed || running || (!initial && handledRevision === revision)) return
      running = true
      try {
        let current: number
        do {
          current = revision
          try {
            const next = await loadSnapshot(projectDir)
            // 串行读取；丢弃读取期间已被新事件取代的结果。
            if (disposed) return
            if (current !== revision) continue
            snapshot = next
            if (!initial) await ctx.model.reload()
          } catch (error) {
            // 保留最后成功快照，后续配置事件仍可重试。
            if (!disposed) report(error)
          }
          if (!disposed) handledRevision = current
        } while (!disposed && current !== revision)
      } finally {
        running = false
      }
    }
    const changed = () => {
      if (disposed) return
      revision++
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (ready) void refresh()
      }, 75)
    }
    // 按文件轮询也能发现尚不存在的全局目录，无需创建宿主目录。
    const files = [...new Set([projectDir, getGlobalConfigDir()])].flatMap((directory) =>
      ["jsonc", "json"].map((extension) => path.join(directory, `oc-auto-model-config.${extension}`)),
    )
    for (const file of files) watchFile(file, { interval: 250, persistent: false }, changed)
    const cleanup = () => {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      for (const file of files) unwatchFile(file, changed)
    }

    await refresh(true)
    ready = true

    // 只注册一次：宿主 reload 重建干净模型基底并按序重放 transform，不重新执行 setup。
    // transform 由宿主 Scope 自动释放；cleanup 只清理插件自有的监听和计时器。
    await Promise.resolve(ctx.model.transform((editor) => {
      if (disposed || !snapshot) return
      const { pluginConfig, modelsDev, allResolved, cacheAge, dumper } = snapshot
      const enhancedModels: Record<string, Record<string, EnhancedModelResult>> = {}

      for (const [providerName, resolvedMap] of allResolved) {
        // 检查 provider 是否存在于 editor 中
        const existingProvider = editor.provider.get(providerName)
        if (!existingProvider) {
          continue
        }

        enhancedModels[providerName] = {}

        for (const [modelId, resolved] of resolvedMap) {
          if (resolved.warning) {
            enhancedModels[providerName][modelId] = {
              source: resolved.source,
              filledFields: [],
              warning: resolved.warning,
            }
            continue
          }

          // 检查 model 是否存在于 provider 中
          const existingModel = editor.get(providerName, modelId)
          if (!existingModel) {
            enhancedModels[providerName][modelId] = {
              source: resolved.source,
              resolvedSource: resolved.resolvedSource,
              filledFields: [],
              skipped: true,
            }
            continue
          }

          const v2Fields = fieldsFromModelsDev(resolved.modelData)
          const actuallyFilledFields: string[] = []

          // 每个模型的初始默认值直接来自 OpenCode V2 契约，避免硬编码默认常量。
          // 宿主假设：未显式配置字段的当前值等于此处返回的默认值（见 mergeModelField 注释）。
          const modelDefaults = Model.Info.default(
            providerName as ModelDefaultArgs[0],
            modelId as ModelDefaultArgs[1],
          ) as unknown as PlainRecord

          // 仅补全未设置或仍为 Model.Info.default 默认初值的叶子，绝不覆盖用户显式值
          // 特例：当配置了 override.cost === true 且 models.dev 存在 cost 数据时，强制覆盖 cost 字段
          const forceOverrideCost = pluginConfig.override?.cost === true && v2Fields.cost !== undefined

          editor.update(providerName, modelId, (modelToUpdate) => {
            const mutableModel = modelToUpdate as unknown as PlainRecord
            for (const [key, value] of Object.entries(v2Fields)) {
              if (value === undefined) continue

              if (key === "cost" && forceOverrideCost) {
                mutableModel[key] = value
                actuallyFilledFields.push(key)
                continue
              }

              const { shouldFill, value: mergedValue } = mergeModelField(
                modelDefaults,
                key,
                mutableModel[key],
                value,
              )

              if (shouldFill) {
                mutableModel[key] = mergedValue
                actuallyFilledFields.push(key)
              }
            }
          })

          enhancedModels[providerName][modelId] = {
            source: resolved.source,
            resolvedSource: resolved.resolvedSource,
            filledFields: actuallyFilledFields,
            model: editor.get(providerName, modelId) as unknown as Record<string, unknown>,
          }
        }
      }

      // 独立于 mapping：只处理 costMapping 里列出的模型，且只写 cost。
      // 放在 mapping 之后，重叠时价格以 costMapping 为准。不读取 override.cost，也不扫描 editor.list()。
      if (pluginConfig.costMapping && Object.keys(pluginConfig.costMapping).length > 0) {
        applyCostMapping(editor, modelsDev, pluginConfig.costMapping, enhancedModels)
      }

      if (dumper) {
        dumper.dumpV2(enhancedModels, allResolved, cacheAge).catch((err) => {
          console.error("[auto-model-config] Failed to write debug dump:", err)
        })
      }
    })).catch((error) => {
      cleanup()
      throw error
    })
    return cleanup
  },
})

export default AutoModelConfigPlugin
