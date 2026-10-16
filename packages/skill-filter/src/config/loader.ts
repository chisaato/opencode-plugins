import fs from "node:fs/promises"
import {
  getDefaultConfigPaths,
  getProjectConfigCandidateGroups,
  resolveUserPath,
  type PathResolutionOptions,
} from "../utils/paths"
import { parseJsonc } from "./jsonc"
import { resolveOverrides } from "./overrides"
import { isPlainObject, mergeConfigs, normalizeConfig, toRules } from "./schema"
import type { NormalizedRules, SkillFilterConfig } from "../types"

export interface LoadConfigOptions extends PathResolutionOptions {
  /** opencode.jsonc 中 plugin options 传入的内联配置。 */
  inline?: Record<string, unknown> | undefined
}

export interface ResolvedConfig {
  rules: NormalizedRules
  debug: boolean
  /** 是否注册 `skills_list` 工具（默认 true）。 */
  exposeTool: boolean
  /** 是否把 remove 规则同步为内核 policy（默认 true）。 */
  syncPolicy: boolean
  /** 显式指定的 policy 目标配置文件（可选）。 */
  syncPolicyPath?: string
  /** 成功读取的来源（文件路径，以及内联 options / override 的标记）。 */
  sources: string[]
}

interface LoadedFile {
  path: string
  raw: Record<string, unknown>
}

const INLINE_SOURCE = "inline plugin options"

/**
 * 加载并合并插件配置（多层）。
 *
 * 合并顺序（后层覆盖前层，按字段）：
 * 1. 全局配置：`~/.config/opencode/skill-filter.jsonc` → `skill-filter.json`
 * 2. 全局配置内的 `overrides`：键为目录 glob，命中当前目录时合并
 * 3. 项目级配置：`.opencode/skill-filter.jsonc` → `.opencode/skill-filter.json`
 *    → 项目根 `skill-filter.jsonc` → 项目根 `skill-filter.json`
 * 4. 内联 plugin options（最高）
 *
 * 同一目录只选用一份：jsonc 存在时不再读取同目录 json（解析失败也只警告，不回退）。
 * 全局与项目之间仍按字段合并。项目目录之间仍是先成功解析先停，不合并更低目录。
 * 显式路径无论扩展名都按 JSONC 解析，并跳过默认搜索。
 *
 * 内联 options 中若给出 `configPath`：
 * - 字符串：只读取该路径，跳过默认搜索
 * - `false`：完全跳过文件读取
 *
 * 目录通过 `ctx.location.directory` 或 `process.cwd()` 获取。
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig> {
  const inline = isPlainObject(options?.inline) ? options.inline : undefined
  const directory = options?.projectDirectory ?? process.cwd()
  const sources: string[] = []

  let merged: SkillFilterConfig = {}

  const explicitPath = typeof inline?.configPath === "string" ? inline.configPath : undefined
  const skipFile = inline?.configPath === false

  if (!skipFile) {
    if (explicitPath) {
      // 显式路径只有一份，不派生同目录的另一种扩展名。
      const loaded = await readPreferredConfig([explicitPath])
      if (loaded) {
        sources.push(loaded.path)
        const explicitConfig = normalizeConfig(loaded.raw, loaded.path)
        merged = mergeConfigs(merged, explicitConfig)

        const override = resolveOverrides(explicitConfig.overrides, directory)
        if (override) {
          merged = mergeConfigs(merged, override)
          sources.push(`overrides (${directory})`)
        }
      }
    } else {
      // 1. 全局配置（同目录 jsonc 优先，不与 json 合并）
      const globalLoaded = await readPreferredConfig(getDefaultConfigPaths(options))
      if (globalLoaded) {
        sources.push(globalLoaded.path)
        const globalConfig = normalizeConfig(globalLoaded.raw, globalLoaded.path)
        merged = mergeConfigs(merged, globalConfig)

        // 2. 全局配置内的目录级 override
        const override = resolveOverrides(globalConfig.overrides, directory)
        if (override) {
          merged = mergeConfigs(merged, override)
          sources.push(`overrides (${directory})`)
        }
      }

      // 3. 项目级配置：目录之间先成功解析先停；目录内部只选一份。
      for (const group of getProjectConfigCandidateGroups(directory)) {
        const loaded = await readPreferredConfig(group)
        if (loaded) {
          sources.push(loaded.path)
          const projectConfig = normalizeConfig(loaded.raw, loaded.path)
          merged = mergeConfigs(merged, projectConfig)

          const override = resolveOverrides(projectConfig.overrides, directory)
          if (override) {
            merged = mergeConfigs(merged, override)
            sources.push(`overrides (${directory})`)
          }
          break
        }
      }
    }
  }

  // 4. 内联 options（最高）
  if (inline) {
    merged = mergeConfigs(merged, normalizeConfig(inline, INLINE_SOURCE))
    sources.push(INLINE_SOURCE)
  }

  return {
    rules: toRules(merged),
    debug: merged.debug ?? true,
    exposeTool: merged.exposeTool ?? true,
    syncPolicy: merged.syncPolicy ?? true,
    ...(merged.syncPolicyPath !== undefined ? { syncPolicyPath: merged.syncPolicyPath } : {}),
    sources,
  }
}

type ConfigRead =
  | { kind: "loaded"; file: LoadedFile }
  | { kind: "missing" }
  | { kind: "rejected" }

/**
 * 在同一目录的候选里只选一份。
 *
 * 候选按优先级排列（jsonc 在前）。文件不存在才尝试下一份；
 * 文件存在但读失败或解析失败时警告并停止，不回退同目录的后续文件。
 */
async function readPreferredConfig(candidates: readonly string[]): Promise<LoadedFile | null> {
  for (const candidate of candidates) {
    const result = await readConfigFile(candidate)
    if (result.kind === "loaded") {
      return result.file
    }
    if (result.kind === "rejected") {
      return null
    }
  }
  return null
}

async function readConfigFile(configPath: string): Promise<ConfigRead> {
  const resolved = resolveUserPath(configPath)
  let text: string
  try {
    text = await fs.readFile(resolved, "utf-8")
  } catch (error) {
    // 文件不存在是正常回退场景，不产生噪音；其它读取失败给出可诊断信息。
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { kind: "missing" }
    }
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[skill-filter] Failed to read config at ${resolved}: ${reason}`)
    return { kind: "rejected" }
  }

  try {
    const parsed: unknown = parseJsonc(text)
    if (!isPlainObject(parsed)) {
      console.warn(`[skill-filter] Ignoring config at ${resolved}: expected a JSON object`)
      return { kind: "rejected" }
    }
    return { kind: "loaded", file: { path: resolved, raw: parsed } }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[skill-filter] Failed to read config at ${resolved}: ${reason}`)
    return { kind: "rejected" }
  }
}
