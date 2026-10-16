import { isDeepStrictEqual } from "node:util"
import { Plugin, Model } from "@opencode/plugin"
import { ModelsDevCache } from "../cache/models-dev-cache"
import { loadConfig, getMappedProviders } from "../mapping/parser"
import { resolveProviderModels } from "../mapping/resolver"
import { fieldsFromModelsDev } from "../utils/fields-mapper"
import { ConfigDumper, type EnhancedModelResult } from "../debug/config-dumper"
import type { ResolvedModel } from "../types"

type PlainRecord = Record<string, unknown>

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
    const projectDir = ctx.location?.directory
    const pluginConfig = await loadConfig({ projectDirectory: projectDir })
    if (!pluginConfig) {
      return
    }

    const cache = new ModelsDevCache({
      cachePath: pluginConfig.cachePath ?? undefined,
      cacheTTL: pluginConfig.cacheTTL,
      projectDirectory: projectDir,
    })

    let modelsDev
    try {
      modelsDev = await cache.get()
    } catch (error) {
      console.error(
        "[auto-model-config] Failed to load models.dev data:",
        error instanceof Error ? error.message : String(error),
      )
      return
    }

    if (!modelsDev) {
      console.warn("[auto-model-config] No models.dev data available")
      return
    }

    const cacheAge = await cache.getAge()
    const mappedProviders = getMappedProviders(pluginConfig)
    const debugConfig = pluginConfig.debug
    const dumper = debugConfig?.enabled
      ? new ConfigDumper({ ...debugConfig, projectDirectory: projectDir })
      : null

    // 解析映射
    const allResolved = new Map<string, Map<string, ResolvedModel>>()
    for (const providerName of mappedProviders) {
      const resolved = resolveProviderModels(modelsDev, pluginConfig, providerName)
      allResolved.set(providerName, resolved)
    }

    // 注册 V2 model transform
    await ctx.model.transform((editor) => {
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
            filledFields: actuallyFilledFields,
            model: editor.get(providerName, modelId) as unknown as Record<string, unknown>,
          }
        }
      }

      if (dumper) {
        dumper.dumpV2(enhancedModels, allResolved, cacheAge).catch((err) => {
          console.error("[auto-model-config] Failed to write debug dump:", err)
        })
      }
    })
  },
})

export default AutoModelConfigPlugin
