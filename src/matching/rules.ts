import { firstMatchingPattern } from "./glob"
import type { NormalizedRules } from "../types"

/** skill 的判定身份。优先使用 name，同时兼容 id。 */
export interface SkillIdentity {
  id?: string
  name?: string
}

export type FilterAction = "hide" | "show" | "leave"

export interface Decision {
  action: FilterAction
  /** 人类可读的原因，便于日志诊断。 */
  reason: string
  /** 命中的规则（若因某条规则命中而决策）。 */
  matched?: string
}

/**
 * 计算单个 skill 应执行的动作。
 *
 * 优先级（由高到低）：
 * 1. `unhide`   白名单 —— 命中的 skill 永不隐藏；开启 restoreUnhidden 时返回 `show`
 * 2. `exclude`  排除项 —— 命中则完全不处理
 * 3. `include`  收窄范围 —— 非空时，未命中的 skill 不处理
 * 4. `hide`     命中则隐藏（autoinvoke = false）
 * 5. 其余情况保持原样
 *
 * 判定会同时考察 skill 的 name 与 id，任一命中即视为命中。
 */
export function decideAction(skill: SkillIdentity, rules: NormalizedRules): Decision {
  const targets = uniqueTargets(skill)

  const unhidden = firstMatchAcross(targets, rules.unhide)
  if (unhidden) {
    if (rules.restoreUnhidden) {
      return { action: "show", reason: "matched unhide (restore)", matched: unhidden }
    }
    return { action: "leave", reason: "matched unhide (keep visible)", matched: unhidden }
  }

  const excluded = firstMatchAcross(targets, rules.exclude)
  if (excluded) {
    return { action: "leave", reason: "matched exclude", matched: excluded }
  }

  if (rules.include.length > 0 && !firstMatchAcross(targets, rules.include)) {
    return { action: "leave", reason: "not in include scope" }
  }

  const hidden = firstMatchAcross(targets, rules.hide)
  if (hidden) {
    return { action: "hide", reason: "matched hide", matched: hidden }
  }

  return { action: "leave", reason: "no rule matched" }
}

/** 是否配置了任何会产生副作用的规则。 */
export function hasWork(rules: NormalizedRules): boolean {
  return rules.hide.length > 0 || (rules.restoreUnhidden && rules.unhide.length > 0)
}

function uniqueTargets(skill: SkillIdentity): string[] {
  const targets: string[] = []
  for (const candidate of [skill.name, skill.id]) {
    if (typeof candidate === "string" && candidate !== "" && !targets.includes(candidate)) {
      targets.push(candidate)
    }
  }
  return targets
}

function firstMatchAcross(targets: readonly string[], patterns: readonly string[]): string | undefined {
  if (patterns.length === 0) {
    return undefined
  }
  for (const target of targets) {
    const matched = firstMatchingPattern(target, patterns)
    if (matched) {
      return matched
    }
  }
  return undefined
}
