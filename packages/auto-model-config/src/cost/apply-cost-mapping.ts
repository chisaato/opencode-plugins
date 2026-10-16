import type { ModelsDevData } from "../types"
import type { EnhancedModelResult } from "../debug/config-dumper"
import { resolveSourceTarget } from "../mapping/resolver"
import { costArrayFromModelsDev, hasNumericCost } from "../utils/fields-mapper"

/**
 * transform 回调里的 editor 子集。
 * 只使用 get / update / provider.get，不调用 list()，因此不会枚举未列出的模型。
 * update 回调参数用 any，避免 DeepMutable<Model.Info> 的回调逆变把调用点卡死。
 */
export interface CostMappingEditor {
  provider: { get(providerID: string): unknown }
  get(providerID: string, modelID: string): unknown
  update(providerID: string, modelID: string, update: (model: any) => void): void
}

/**
 * 按手填 costMapping 只覆盖列出模型的 cost。
 * 必须在 metadata mapping 之后调用：重叠时 cost 以本函数写入的源为准。
 * 未知源或源没有数字 cost 时不改模型，并把原因记到 enhancedModels，供 debug dump 输出。
 */
export function applyCostMapping(
  editor: CostMappingEditor,
  modelsDev: ModelsDevData,
  costMapping: Record<string, Record<string, string>>,
  enhancedModels: Record<string, Record<string, EnhancedModelResult>>,
): void {
  for (const [providerID, models] of Object.entries(costMapping)) {
    const providerExists = editor.provider.get(providerID) != null
    for (const [modelID, target] of Object.entries(models)) {
      if (!providerExists) {
        record(enhancedModels, providerID, modelID, {
          source: target,
          filledFields: [],
          skipped: true,
          costSource: target,
          costWarning: `Provider "${providerID}" not found in editor`,
        })
        continue
      }

      if (editor.get(providerID, modelID) == null) {
        record(enhancedModels, providerID, modelID, {
          source: target,
          filledFields: [],
          skipped: true,
          costSource: target,
          costWarning: `Model "${modelID}" not found in editor`,
        })
        continue
      }

      const lookedUp = resolveSourceTarget(modelsDev, target)
      if (lookedUp.warning || !lookedUp.modelData) {
        const warning = lookedUp.warning ?? `Model target "${target}" could not be resolved`
        record(enhancedModels, providerID, modelID, {
          source: target,
          filledFields: [],
          warning,
          costSource: target,
          costWarning: warning,
        })
        continue
      }

      if (!hasNumericCost(lookedUp.modelData.cost)) {
        const warning = `Source "${target}" has no cost`
        record(enhancedModels, providerID, modelID, {
          source: target,
          filledFields: [],
          warning,
          costSource: target,
          costWarning: warning,
        })
        continue
      }

      const cost = costArrayFromModelsDev(lookedUp.modelData.cost)
      editor.update(providerID, modelID, (model) => {
        model.cost = cost
      })
      record(enhancedModels, providerID, modelID, {
        source: target,
        filledFields: ["cost"],
        model: editor.get(providerID, modelID) as Record<string, unknown> | undefined,
        costSource: target,
      })
    }
  }
}

function record(
  enhancedModels: Record<string, Record<string, EnhancedModelResult>>,
  providerID: string,
  modelID: string,
  next: EnhancedModelResult,
): void {
  if (!enhancedModels[providerID]) enhancedModels[providerID] = {}
  const existing = enhancedModels[providerID][modelID]
  if (!existing) {
    enhancedModels[providerID][modelID] = next
    return
  }

  // 保留 mapping 已写入的 source / warning / 其它 filledFields，只补充价格结果。
  existing.costSource = next.costSource
  if (next.costWarning) {
    existing.costWarning = next.costWarning
    return
  }
  if (!existing.filledFields.includes("cost")) existing.filledFields.push("cost")
  if (next.model) existing.model = next.model
}
