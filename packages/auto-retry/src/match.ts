import type { Rule } from "./config/schema"

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * 从上到下找第一条同时命中的规则。
 * models 支持 `*` 通配（可跨 `/`），errors 是错误文案的子串。
 */
export function matchRule(
  rules: readonly Rule[],
  input: { model: string; errorMessage: string },
): Rule | undefined {
  return rules.find(
    (rule) =>
      rule.models.some((pattern) => matchModel(input.model, pattern)) &&
      rule.errors.some((needle) => needle.length > 0 && input.errorMessage.includes(needle)),
  )
}

/** `providerID/id`，不含 variant。规则按这个字符串匹配。 */
export function formatModel(model: { providerID?: string; id?: string } | undefined): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}

function matchModel(model: string, pattern: string): boolean {
  if (model.length === 0 || pattern.length === 0) return false
  const source = pattern.split("*").map((part) => part.replace(REGEX_SPECIAL, "\\$&")).join(".*")
  return new RegExp(`^${source}$`).test(model)
}
