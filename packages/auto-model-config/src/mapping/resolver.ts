import type { ModelsDevData, AutoModelConfig, ResolvedModel } from "../types"
import { fieldsFromModelsDev } from "../utils/fields-mapper"

/**
 * 解析单个模型映射：在 models.dev 数据中查找目标 provider/model，
 * 并返回解析后的模型元数据。
 */
export function resolveModel(
  modelsDev: ModelsDevData,
  config: AutoModelConfig,
  providerName: string,
  modelId: string,
): ResolvedModel | null {
  const providerMapping = config.mapping[providerName]
  if (!providerMapping) return null

  const target = providerMapping[modelId]
  if (!target) return null

  const source = target

  // 解析 "provider/modelId" 格式
  const slashIndex = target.indexOf("/")
  if (slashIndex === -1) {
    return {
      source,
      modelData: {} as any,
      filledFields: [],
      warning: `Invalid mapping format "${target}" — expected "provider/modelId"`,
    }
  }

  const targetProvider = target.slice(0, slashIndex)
  const targetModelId = target.slice(slashIndex + 1)

  // 查找 provider
  const providerData = modelsDev[targetProvider]
  if (!providerData) {
    return {
      source,
      modelData: {} as any,
      filledFields: [],
      warning: `Provider "${targetProvider}" not found in models.dev data`,
    }
  }

  // 查找模型 — 先尝试精确匹配，再进行大小写不敏感匹配
  let modelData = providerData.models[targetModelId]
  if (!modelData) {
    // 大小写不敏感搜索
    const lowerTarget = targetModelId.toLowerCase()
    for (const key of Object.keys(providerData.models)) {
      if (key.toLowerCase() === lowerTarget) {
        modelData = providerData.models[key]
        break
      }
      // 同时检查模型内部的 id 字段
      const m = providerData.models[key]
      if (m.id?.toLowerCase() === lowerTarget) {
        modelData = m
        break
      }
    }
  }

  if (!modelData) {
    return {
      source,
      modelData: {} as any,
      filledFields: [],
      warning: `Model "${targetModelId}" not found in provider "${targetProvider}"`,
    }
  }

  const configFields = fieldsFromModelsDev(modelData)
  const filledFields = Object.keys(configFields)

  return {
    source,
    modelData,
    filledFields,
  }
}

/**
 * 解析指定 provider 的所有模型。
 * 返回 modelId → ResolvedModel 的映射表（包含失败项及其警告信息）。
 */
export function resolveProviderModels(
  modelsDev: ModelsDevData,
  config: AutoModelConfig,
  providerName: string,
): Map<string, ResolvedModel> {
  const result = new Map<string, ResolvedModel>()
  const providerMapping = config.mapping[providerName]
  if (!providerMapping) return result

  for (const modelId of Object.keys(providerMapping)) {
    const resolved = resolveModel(modelsDev, config, providerName, modelId)
    if (resolved) {
      result.set(modelId, resolved)
    }
  }

  return result
}
