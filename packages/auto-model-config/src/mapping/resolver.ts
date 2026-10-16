import type { ModelsDevData, ModelsDevModel, AutoModelConfig, ResolvedModel } from "../types"
import { fieldsFromModelsDev } from "../utils/fields-mapper"

export interface SourceTarget {
  source: string
  modelData: ModelsDevModel | null
  warning?: string
}

/**
 * 解析显式的 "provider/modelId" 目标。
 * 先精确匹配，再大小写不敏感匹配 key 与条目 id。不做别名或模糊猜测。
 * metadata mapping 与 costMapping 共用这一查找，填充策略仍各自分开。
 */
export function resolveSourceTarget(modelsDev: ModelsDevData, target: string): SourceTarget {
  const source = target
  const slashIndex = target.indexOf("/")
  if (slashIndex === -1) {
    return {
      source,
      modelData: null,
      warning: `Invalid mapping format "${target}" — expected "provider/modelId"`,
    }
  }

  const targetProvider = target.slice(0, slashIndex)
  const targetModelId = target.slice(slashIndex + 1)
  const providerData = modelsDev[targetProvider]
  if (!providerData) {
    return {
      source,
      modelData: null,
      warning: `Provider "${targetProvider}" not found in models.dev data`,
    }
  }

  let modelData = providerData.models[targetModelId]
  if (!modelData) {
    const lowerTarget = targetModelId.toLowerCase()
    for (const key of Object.keys(providerData.models)) {
      if (key.toLowerCase() === lowerTarget) {
        modelData = providerData.models[key]
        break
      }
      const entry = providerData.models[key]
      if (entry.id?.toLowerCase() === lowerTarget) {
        modelData = entry
        break
      }
    }
  }

  if (!modelData) {
    return {
      source,
      modelData: null,
      warning: `Model "${targetModelId}" not found in provider "${targetProvider}"`,
    }
  }

  return { source, modelData }
}

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

  const lookedUp = resolveSourceTarget(modelsDev, target)
  if (lookedUp.warning || !lookedUp.modelData) {
    return {
      source: lookedUp.source,
      modelData: {} as any,
      filledFields: [],
      warning: lookedUp.warning,
    }
  }

  const modelData = lookedUp.modelData
  const configFields = fieldsFromModelsDev(modelData)
  const filledFields = Object.keys(configFields)

  return {
    source: lookedUp.source,
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
