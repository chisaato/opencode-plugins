import type { ModelsDevData, ModelsDevModel, AutoModelConfig, ResolvedModel, ModelMatchCriteria } from "../types"
import { fieldsFromModelsDev } from "../utils/fields-mapper"

export interface SourceTarget {
  source: string
  modelData: ModelsDevModel | null
  resolvedSource?: string
  warning?: string
}

interface Candidate {
  providerId: string
  modelKey: string
  modelData: ModelsDevModel
}

function selectCandidate(matches: Candidate[], canonical: string | undefined): Candidate {
  const expectedKey = canonical?.slice(canonical.lastIndexOf("/") + 1).toLowerCase()
  const expectedProvider = canonical?.split("/")[0].toLowerCase()
  // 依次按模型 key、provider、provider 字母序、模型 key 字母序排序。
  matches.sort((a, b) =>
    Number(b.modelKey.toLowerCase() === expectedKey) - Number(a.modelKey.toLowerCase() === expectedKey)
    || Number(b.providerId.toLowerCase() === expectedProvider) - Number(a.providerId.toLowerCase() === expectedProvider)
    || (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0)
    || (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0)
  )
  return matches[0]
}

function findCanonicalModel(modelsDev: ModelsDevData, target: string): SourceTarget | null {
  const candidates: Candidate[] = []
  const insensitiveCandidates: typeof candidates = []
  for (const [providerId, provider] of Object.entries(modelsDev)) {
    for (const [modelKey, modelData] of Object.entries(provider.models)) {
      const canonical = modelData.canonical_model_id
      if (canonical === target) {
        candidates.push({ providerId, modelKey, modelData })
      } else if (canonical?.toLowerCase() === target.toLowerCase()) {
        insensitiveCandidates.push({ providerId, modelKey, modelData })
      }
    }
  }

  const matches = candidates.length ? candidates : insensitiveCandidates
  if (!matches.length) return null

  const winner = selectCandidate(matches, target)
  return { source: target, modelData: winner.modelData, resolvedSource: `${winner.providerId}/${winner.modelKey}` }
}

function findByCriteria(modelsDev: ModelsDevData, criteria: ModelMatchCriteria): SourceTarget {
  const source = JSON.stringify(criteria)
  const matches: Candidate[] = []
  for (const [providerId, provider] of Object.entries(modelsDev)) {
    for (const [modelKey, modelData] of Object.entries(provider.models)) {
      const fields = modelData as unknown as Record<string, unknown>
      const matched = Object.entries(criteria).every(([key, value]) => {
        if (key === "provider") return providerId.toLowerCase() === value.toLowerCase()
        const actual = fields[key]
        // 条件要求模型条目中存在同名字段且为字符串，避免隐式转换和误命中。
        return typeof actual === "string" && actual.toLowerCase() === value.toLowerCase()
      })
      if (matched) matches.push({ providerId, modelKey, modelData })
    }
  }
  if (!matches.length) {
    return { source, modelData: null, warning: `No models.dev entry matches criteria ${source}` }
  }
  const winner = selectCandidate(matches, criteria.canonical_model_id)
  return { source, modelData: winner.modelData, resolvedSource: `${winner.providerId}/${winner.modelKey}` }
}

/**
 * 解析显式的 "provider/modelId" 或模型条目字段条件目标。
 * 先精确匹配，再大小写不敏感匹配 key 与条目 id；未命中时查 canonical_model_id。
 * metadata mapping 与 costMapping 共用这一查找，填充策略仍各自分开。
 */
export function resolveSourceTarget(modelsDev: ModelsDevData, target: string | ModelMatchCriteria): SourceTarget {
  if (typeof target !== "string") return findByCriteria(modelsDev, target)
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
    return findCanonicalModel(modelsDev, target) ?? {
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
    return findCanonicalModel(modelsDev, target) ?? {
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
    ...(lookedUp.resolvedSource ? { resolvedSource: lookedUp.resolvedSource } : {}),
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
