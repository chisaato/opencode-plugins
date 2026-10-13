import fs from "node:fs/promises"
import path from "node:path"
import {
  getDefaultConfigPath,
  getProjectConfigPaths,
  type PathResolutionOptions,
} from "../utils/paths"
import { isPlainObject, mergeConfigs, normalizeConfig, toRules } from "./schema"
import type { NormalizedRules } from "../types"

export interface LoadConfigOptions extends PathResolutionOptions {
  /** opencode.jsonc 中 plugin options 传入的内联配置。 */
  inline?: Record<string, unknown> | undefined
}

export interface ResolvedConfig {
  rules: NormalizedRules
  debug: boolean
  /** 是否注册 `skills_list` 工具（默认 true）。 */
  exposeTool: boolean
  /** 成功读取的来源（文件路径，以及内联 options 的标记）。 */
  sources: string[]
}

interface LoadedFile {
  path: string
  raw: Record<string, unknown>
}

const INLINE_SOURCE = "inline plugin options"

/**
 * 加载并合并插件配置。
 *
 * 文件搜索顺序（先命中先用）：
 * 1. `<project>/.opencode/skill-filter.json`
 * 2. `<project>/skill-filter.json`
 * 3. `~/.config/opencode/skill-filter.json`（遵循 XDG_CONFIG_HOME / 注入的 HOME）
 *
 * 内联 options 中若给出 `configPath`：
 * - 字符串：只读取该路径，跳过默认搜索
 * - `false`：完全跳过文件读取
 *
 * 合并规则见 `mergeConfigs`：内联字段优先。
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig> {
  const inline = isPlainObject(options?.inline) ? options.inline : undefined
  const sources: string[] = []

  let fileRaw: Record<string, unknown> | undefined
  let filePath: string | undefined

  const explicitPath = typeof inline?.configPath === "string" ? inline.configPath : undefined
  const skipFile = inline?.configPath === false

  if (!skipFile) {
    if (explicitPath) {
      const loaded = await readConfigFile(explicitPath)
      if (loaded) {
        fileRaw = loaded.raw
        filePath = loaded.path
        sources.push(loaded.path)
      }
    } else {
      for (const candidate of candidatePaths(options)) {
        const loaded = await readConfigFile(candidate)
        if (loaded) {
          fileRaw = loaded.raw
          filePath = loaded.path
          sources.push(loaded.path)
          break
        }
      }
    }
  }

  const fileConfig = normalizeConfig(fileRaw, filePath ?? "config file")
  const inlineConfig = normalizeConfig(inline, INLINE_SOURCE)
  const merged = mergeConfigs(fileConfig, inlineConfig)
  if (inline) {
    sources.push(INLINE_SOURCE)
  }

  return {
    rules: toRules(merged),
    debug: merged.debug ?? true,
    exposeTool: merged.exposeTool ?? true,
    sources,
  }
}

function candidatePaths(options?: LoadConfigOptions): string[] {
  const paths: string[] = []
  if (options?.projectDirectory) {
    paths.push(...getProjectConfigPaths(options.projectDirectory))
  }
  paths.push(getDefaultConfigPath(options))
  return paths
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
