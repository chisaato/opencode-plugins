// OpenCode 内核级 Policy 同步。
//
// 内核插件管道（supervisor.ts）顺序为 `[...pre, ...packages, ...post]`：
// - 第三方外部插件（含本插件）属于 `packages`；
// - `post` 末端是 `ConfigPolicyPlugin`，它在**所有插件之后**执行
//   `ctx.skill.transform`，依据 `experimental.policies` 里的 deny policy
//   调用 `skills.remove(...)` 把技能物理拔除。
//
// 因此只靠运行时的 `editor.remove` 无法对抗“兼容层插件在重载时再次注入技能”，
// 但把规则写成内核 policy 后，内核会在下一次启动时直接把命中的技能拔掉。
// 本模块负责：生成 policy、与已有 policy 合并、并以保留注释的方式写回 jsonc。

import fs from "node:fs/promises"
import path from "node:path"
import { parseJsonc, structurallyEqual, upsertExperimentalPolicies } from "../config/jsonc"
import { isPlainObject } from "../config/schema"
import type { PolicyRule } from "../types"
import { silentLogger, type Logger } from "../utils/logger"
import {
  getGlobalOpenCodeConfigPaths,
  resolveUserPath,
  type PathResolutionOptions,
} from "../utils/paths"

/** 内核 policy 的动作：仅处理 skill 集成准入。 */
export const POLICY_ACTION = "integration.use" as const

/** 由本插件管理的 policy 的 resource 前缀。 */
export const POLICY_RESOURCE_PREFIX = "skill:"

export interface SyncPolicyOptions extends PathResolutionOptions {
  /** 需要同步为 deny policy 的 `remove` glob 规则。 */
  patterns: readonly string[]
  /** 显式指定的目标配置文件（支持 `~`）；缺省时自动查找全局主配置。 */
  targetPath?: string
  logger?: Logger
}

export interface SyncPolicyResult {
  /** 是否成功定位到目标配置文件（不代表发生了写入）。 */
  synced: boolean
  /** 是否实际写入了文件。 */
  written: boolean
  /** 目标配置文件路径（若已定位）。 */
  path?: string
  /** 参与同步的 remove 规则（去重后）。 */
  patterns: string[]
  /** 同步后的完整 policy 列表（含用户原有的非受管 policy）。 */
  policies: unknown[]
  /** 未写入 / 未同步的原因，便于诊断。 */
  reason?: string
}

/** 把一条 glob 规则转成内核 deny policy。 */
export function toPolicyRule(pattern: string): PolicyRule {
  return {
    action: POLICY_ACTION,
    resource: `${POLICY_RESOURCE_PREFIX}${pattern}`,
    effect: "deny",
  }
}

/** 把 remove 规则批量转成 deny policy（按 resource 去重，保持顺序）。 */
export function generatePolicies(patterns: readonly string[]): PolicyRule[] {
  const seen = new Set<string>()
  const result: PolicyRule[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern === "") {
      continue
    }
    const resource = `${POLICY_RESOURCE_PREFIX}${pattern}`
    if (seen.has(resource)) {
      continue
    }
    seen.add(resource)
    result.push(toPolicyRule(pattern))
  }
  return result
}

/**
 * 判断一条 policy 是否由本插件管理。
 *
 * 受管 = `action === "integration.use"` 且 `effect === "deny"`
 * 且 `resource` 以 `skill:` 开头。用户手写的 `allow` policy 或其它
 * action / resource 的 policy 不会被触碰。
 */
export function isManagedPolicy(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    value.action === POLICY_ACTION &&
    value.effect === "deny" &&
    typeof value.resource === "string" &&
    value.resource.startsWith(POLICY_RESOURCE_PREFIX)
  )
}

/** 从解析后的 OpenCode 配置中取出 `experimental.policies`（缺失时返回 `[]`）。 */
export function extractPolicies(config: unknown): unknown[] {
  if (!isPlainObject(config)) {
    return []
  }
  const experimental = config.experimental
  if (!isPlainObject(experimental)) {
    return []
  }
  const policies = experimental.policies
  return Array.isArray(policies) ? policies : []
}

/**
 * 合并 policy：保留用户的非受管 policy，用生成的受管集合**替换**旧的受管集合。
 *
 * 这样规则收缩时不会残留过期 policy，也不会破坏用户手写的 allow 规则。
 */
export function mergePolicies(
  existing: readonly unknown[],
  generated: readonly PolicyRule[],
): unknown[] {
  const kept = existing.filter((policy) => !isManagedPolicy(policy))
  return [...kept, ...generated]
}

/**
 * 按配置把一个 / 多个 remove 规则同步进 OpenCode 主配置。
 *
 * 写入采用外科手术式替换：只改动 `experimental.policies`，文件其余部分
 * （包括全部注释）原样保留。目标文件不存在且未显式指定路径时跳过同步。
 */
export async function syncPolicies(options: SyncPolicyOptions): Promise<SyncPolicyResult> {
  const logger = options.logger ?? silentLogger
  const patterns = dedupeStrings(options.patterns)
  const generated = generatePolicies(patterns)
  const base: SyncPolicyResult = { synced: false, written: false, patterns, policies: [] }

  if (generated.length === 0) {
    return { ...base, reason: "no remove patterns to sync" }
  }

  const target = await resolveTarget(options)
  if (!target) {
    return { ...base, reason: "no opencode config found (opencode.jsonc / opencode.json)" }
  }

  let text: string
  try {
    text = await fs.readFile(target, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.targetPath) {
      // 显式指定路径时允许创建新文件。
      text = "{}\n"
    } else {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`policy sync skipped: cannot read ${target}: ${reason}`)
      return { ...base, path: target, reason: `cannot read target: ${reason}` }
    }
  }

  let existing: unknown[] = []
  try {
    existing = extractPolicies(parseJsonc(text))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`policy sync skipped: cannot parse ${target}: ${reason}`)
    return { ...base, path: target, reason: `cannot parse target: ${reason}` }
  }

  const merged = mergePolicies(existing, generated)
  if (structurallyEqual(merged, existing)) {
    logger.debug(`policy already in sync at ${target}`)
    return { synced: true, written: false, path: target, patterns, policies: merged, reason: "already in sync" }
  }

  const { text: next, changed } = upsertExperimentalPolicies(text, merged)
  if (!changed) {
    return {
      synced: true,
      written: false,
      path: target,
      patterns,
      policies: merged,
      reason: "no textual change produced",
    }
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, next, "utf-8")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`policy sync skipped: cannot write ${target}: ${reason}`)
    return { ...base, path: target, reason: `cannot write target: ${reason}` }
  }

  logger.debug(
    `synced ${generated.length} deny policy(ies) into ${target}: ` +
      generated.map((p) => p.resource).join(", "),
  )
  return { synced: true, written: true, path: target, patterns, policies: merged }
}

/** 解析目标配置文件：显式路径优先，否则取第一个存在的全局主配置。 */
async function resolveTarget(options: SyncPolicyOptions): Promise<string | undefined> {
  if (options.targetPath) {
    return resolveUserPath(options.targetPath)
  }
  for (const candidate of getGlobalOpenCodeConfigPaths(options)) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return undefined
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== "string" || value === "" || seen.has(value)) {
      continue
    }
    seen.add(value)
    result.push(value)
  }
  return result
}
