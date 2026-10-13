import fs from "node:fs/promises"
import path from "node:path"
import {
  getDefaultConfigPath,
  getProjectConfigPaths,
  type PathResolutionOptions,
} from "../utils/paths"
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
 * 1. 全局配置：`~/.config/opencode/skill-filter.json`
 * 2. 全局配置内的 `overrides`：键为目录 glob，命中当前目录时合并
 * 3. 项目级配置：`<project>/.opencode/skill-filter.json` → `<project>/skill-filter.json`
 * 4. 内联 plugin options（最高）
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
      const loaded = await readConfigFile(explicitPath)
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
      // 1. 全局配置
      const globalLoaded = await readConfigFile(getDefaultConfigPath(options))
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

      // 3. 项目级配置（先命中先用）
      for (const candidate of getProjectConfigPaths(directory)) {
        const loaded = await readConfigFile(candidate)
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
    sources,
  }
}

async function readConfigFile(configPath: string): Promise<LoadedFile | null> {
  const resolved = resolvePath(configPath)
  try {
    const raw = await fs.readFile(resolved, "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) {
      console.warn(`[skill-filter] Ignoring config at ${resolved}: expected a JSON object`)
      return null
    }
    return { path: resolved, raw: parsed }
  } catch (error) {
    // 文件不存在是正常回退场景，不产生噪音；其它读取/解析失败给出可诊断信息。
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[skill-filter] Failed to read config at ${resolved}: ${reason}`)
    }
    return null
  }
}

function resolvePath(configPath: string): string {
  if (configPath.startsWith("~")) {
    return path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      configPath.slice(1),
    )
  }
  return path.resolve(configPath)
}
