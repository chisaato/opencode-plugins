import fs from "node:fs/promises"
import path from "node:path"
import { parseJsonc } from "./jsonc"
import { normalizeLayer, type Layer } from "./schema"
import {
  getDefaultConfigPaths,
  getGlobalConfigDir,
  getProjectConfigCandidateGroups,
  PROMPTS_DIR_NAME,
  resolveUserPath,
  type PathResolutionOptions,
} from "../utils/paths"
import { createLogger, type Logger } from "../utils/logger"

export interface LoadConfigOptions extends PathResolutionOptions {
  inline?: Record<string, unknown>
  logger?: Logger
}

export interface ResolvedConfig {
  rules: Layer["rules"]
  sources: string[]
  debug: boolean
  globalPromptsDir: string
  /** 所有候选路径（含当前不存在的文件），用于检测新配置出现。 */
  candidates: string[]
}

/** 同目录 jsonc 一旦存在，解析失败也不降级到 json。 */
async function readGroup(candidates: string[], logger: Logger): Promise<{ status: "missing" | "rejected" | "loaded"; layer?: Layer }> {
  for (const candidate of candidates) {
    let text: string
    try {
      text = await fs.readFile(candidate, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      logger.warn(`Failed to read config at ${candidate}: ${String(error)}`)
      return { status: "rejected" }
    }
    try {
      const layer = normalizeLayer(parseJsonc(text), path.dirname(candidate), candidate, logger)
      return layer ? { status: "loaded", layer } : { status: "rejected" }
    } catch (error) {
      logger.warn(`Failed to parse config at ${candidate}: ${String(error)}`)
      return { status: "rejected" }
    }
  }
  return { status: "missing" }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const logger = options.logger ?? createLogger(false)
  const projectDirectory = options.projectDirectory ?? process.cwd()
  const globalPromptsDir = path.join(getGlobalConfigDir(options), PROMPTS_DIR_NAME)
  const candidates: string[] = []
  const layers: Layer[] = []
  const explicit = options.inline?.configPath
  if (explicit !== false) {
    if (typeof explicit === "string") {
      const target = explicit.startsWith("~/") || path.isAbsolute(explicit)
        ? resolveUserPath(explicit)
        : path.resolve(projectDirectory, explicit)
      candidates.push(target)
      const loaded = await readGroup([target], logger)
      if (loaded.layer) layers.push(loaded.layer)
    } else {
      const global = getDefaultConfigPaths(options)
      candidates.push(...global)
      const loaded = await readGroup(global, logger)
      if (loaded.layer) layers.push(loaded.layer)
      for (const group of getProjectConfigCandidateGroups(projectDirectory)) {
        candidates.push(...group)
        const project = await readGroup(group, logger)
        if (project.layer) layers.push(project.layer)
        if (project.status !== "missing") break
      }
    }
  }
  if (options.inline) {
    const layer = normalizeLayer(
      options.inline,
      projectDirectory,
      "inline plugin options",
      logger,
    )
    if (layer) {
      // 内联默认目录位于项目的 .opencode 下；相对文件路径仍从项目根目录解析。
      for (const rule of layer.rules) {
        if (options.inline.promptsDir === undefined) rule.promptsDir = path.join(projectDirectory, ".opencode", PROMPTS_DIR_NAME)
      }
      layers.push(layer)
    }
  }
  let rules: Layer["rules"] = []
  for (const layer of layers) {
    if (layer.replace) rules = []
    rules.push(...layer.rules)
  }
  return {
    rules,
    sources: layers.map((layer) => layer.source),
    debug: layers.some((layer) => layer.debug),
    globalPromptsDir,
    candidates,
  }
}
