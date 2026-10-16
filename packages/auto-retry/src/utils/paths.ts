import os from "node:os"
import path from "node:path"

/** 同目录只读一份：先 jsonc，文件不存在时才用 json。 */
export const CONFIG_FILENAMES = ["auto-retry.jsonc", "auto-retry.json"] as const

/** 首选文件名。单路径 helper 仍指向它，避免旧调用改去读 json。 */
export const CONFIG_FILENAME = CONFIG_FILENAMES[0]

export interface PathOptions {
  /** 显式注入的 HOME，测试用来避开真实配置。 */
  homeDir?: string
}

/**
 * 全局配置目录。
 *
 * 优先级：homeDir → OPENCODE_TEST_HOME → XDG_CONFIG_HOME/opencode → ~/.config/opencode。
 */
export function globalConfigDir(options?: PathOptions): string {
  if (options?.homeDir) {
    return path.join(options.homeDir, ".config", "opencode")
  }
  if (process.env.OPENCODE_TEST_HOME) {
    return path.join(process.env.OPENCODE_TEST_HOME, ".config", "opencode")
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  }
  return path.join(os.homedir(), ".config", "opencode")
}

/** `~/.config/opencode/auto-retry.jsonc`。 */
export function globalConfigPath(options?: PathOptions): string {
  return path.join(globalConfigDir(options), CONFIG_FILENAME)
}

/**
 * 全局候选，按优先级：
 * `~/.config/opencode/auto-retry.jsonc` → `auto-retry.json`。
 */
export function globalConfigPaths(options?: PathOptions): string[] {
  return configPathsIn(globalConfigDir(options))
}

/** `<project>/.opencode/auto-retry.jsonc`。项目根目录下的同名文件不算。 */
export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".opencode", CONFIG_FILENAME)
}

/**
 * 项目候选，按优先级：
 * `<project>/.opencode/auto-retry.jsonc` → `auto-retry.json`。
 * 不包含项目根目录。
 */
export function projectConfigPaths(projectDir: string): string[] {
  return configPathsIn(path.join(projectDir, ".opencode"))
}

function configPathsIn(dir: string): string[] {
  return CONFIG_FILENAMES.map((name) => path.join(dir, name))
}
