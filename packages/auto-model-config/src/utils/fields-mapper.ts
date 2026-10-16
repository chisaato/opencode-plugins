import type { ModelsDevCost, ModelsDevModel } from "../types"

export interface V2ModelEnhancement {
  name?: string
  family?: string
  capabilities?: {
    tools: boolean
    input: string[]
    output: string[]
  }
  limit?: {
    context: number
    input?: number
    output: number
  }
  cost?: Array<{
    tier?: {
      type: "context"
      size: number
    }
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
  }>
}

/**
 * 将 models.dev 的模型条目映射为 OpenCode V2 模型配置对象。
 * 仅填充在 OpenCode V2 模型模式中有意义的字段：
 * name, family (若源数据存在), capabilities, limit, cost 数组。
 */
export function fieldsFromModelsDev(model: ModelsDevModel): V2ModelEnhancement {
  const result: V2ModelEnhancement = {}

  // 名称（始终填充）
  result.name = model.name

  // 家族（若存在）
  if (model.family) {
    result.family = model.family
  }

  // 能力 (V2 capabilities 结构)
  result.capabilities = {
    tools: Boolean(model.tool_call),
    input: [...(model.modalities?.input ?? ["text"])],
    output: [...(model.modalities?.output ?? ["text"])],
  }

  // 限制（上下文窗口 + 输出）
  result.limit = {
    context: model.limit.context,
    output: model.limit.output,
  }
  // 仅在定义了输入限制且与上下文限制不同时包含
  if (model.limit.input !== undefined && model.limit.input !== model.limit.context) {
    result.limit.input = model.limit.input
  }

  // 费用信息 (V2 cost 数组)。阶梯与 cache 转换集中在 costArrayFromModelsDev，供仅价格映射复用。
  if (model.cost && hasNumericCost(model.cost)) {
    result.cost = costArrayFromModelsDev(model.cost)
  }

  return result
}

/**
 * 源条目是否带有可写入的数字价格。缺字段不是 0 价，调用方应保留原 cost。
 */
export function hasNumericCost(cost: ModelsDevCost | undefined): cost is ModelsDevCost {
  return !!cost && Number.isFinite(cost.input) && Number.isFinite(cost.output)
}

/**
 * 将 models.dev cost 转为 OpenCode V2 cost 数组。
 * 保留基础价、cache，以及源数据里已有的 context_over_200k 阶梯；不发明新费率。
 */
export function costArrayFromModelsDev(
  cost: ModelsDevCost,
): NonNullable<V2ModelEnhancement["cost"]> {
  const costArray: NonNullable<V2ModelEnhancement["cost"]> = []

  costArray.push({
    input: cost.input,
    output: cost.output,
    cache: {
      read: cost.cache_read ?? 0,
      write: cost.cache_write ?? 0,
    },
  })

  if (cost.context_over_200k) {
    costArray.push({
      tier: {
        type: "context",
        size: 200000,
      },
      input: cost.context_over_200k.input,
      output: cost.context_over_200k.output,
      cache: {
        read: cost.context_over_200k.cache_read ?? 0,
        write: 0,
      },
    })
  }

  return costArray
}

/**
 * 确定 fieldsFromModelsDev 会设置哪些字段。
 * 用于在调试模式下跟踪已填充的字段。
 */
export function getFillableFields(): string[] {
  return [
    "name",
    "family",
    "capabilities",
    "limit",
    "cost",
  ]
}
