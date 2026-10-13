import path from "node:path"
import os from "node:os"

export interface PathResolutionOptions {
  /** 项目目录（ctx.location.directory）。用于定位项目内的插件配置。 */
  projectDirectory?: string
  /** 显式注入的 HOME（主要用于隔离测试，避免污染宿主真实配置）。 */
  homeDirectory?: string
}

/** 插件自身的配置文件名。 */
export const CONFIG_FILENAME = "skill-filter.json"

/**
 * 解析 OpenCode 的全局配置目录。
 * 优先级（由高到低）：
 * 1. options.homeDirectory（显式注入，例如隔离测试）
 * 2. process.env.OPENCODE_TEST_HOME（测试环境变量）
 * 3. process.env.XDG_CONFIG_HOME（存在时取 path.join(XDG_CONFIG_HOME, "opencode")）
 * 4. os.homedir()（回退：~/.config/opencode）
 */
export function getGlobalConfigDir(options?: PathResolutionOptions): string {
  if (options?.homeDirectory) {
    return path.join(options.homeDirectory, ".config", "opencode")
  }

  if (process.env.OPENCODE_TEST_HOME) {
    return path.join(process.env.OPENCODE_TEST_HOME, ".config", "opencode")
  }

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  }

  return path.join(os.homedir(), ".config", "opencode")
}

/** 全局默认配置文件路径：`~/.config/opencode/skill-filter.json`。 */
export function getDefaultConfigPath(options?: PathResolutionOptions): string {
  return path.join(getGlobalConfigDir(options), CONFIG_FILENAME)
}

/**
 * 项目内候选配置文件路径（按优先级）。
 * 首选 `.opencode/skill-filter.json`，其次项目根目录下的 `skill-filter.json`。
 */
export function getProjectConfigPaths(projectDirectory: string): string[] {
  return [
    path.join(projectDirectory, ".opencode", CONFIG_FILENAME),
    path.join(projectDirectory, CONFIG_FILENAME),
  ]
}
