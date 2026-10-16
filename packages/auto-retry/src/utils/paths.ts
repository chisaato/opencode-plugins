import os from "node:os"
import path from "node:path"

export const CONFIG_FILENAME = "auto-retry.jsonc"

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

/** `<project>/.opencode/auto-retry.jsonc`。项目根目录下的同名文件不算。 */
export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".opencode", CONFIG_FILENAME)
}
