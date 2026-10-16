import path from "node:path"
import os from "node:os"

export interface PathResolutionOptions {
  projectDirectory?: string
  homeDirectory?: string
}

/**
 * 解析 OpenCode 的全局配置目录。
 * 优先级（由高到低，与代码实现一致）：
 * 1. options.homeDirectory (若显式传入，例如在隔离测试中：path.join(home, ".config", "opencode"))
 * 2. process.env.OPENCODE_TEST_HOME (测试环境变量)
 * 3. process.env.XDG_CONFIG_HOME (若存在，则为 path.join(process.env.XDG_CONFIG_HOME, "opencode"))
 * 4. os.homedir() (回退: path.join(os.homedir(), ".config", "opencode"))
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

/**
 * 运行时动态获取默认 models-dev.json 缓存路径
 */
export function getDefaultCachePath(options?: PathResolutionOptions): string {
  return path.join(getGlobalConfigDir(options), "models-dev.json")
}

/**
 * 运行时动态获取默认 debug dump 输出路径
 */
export function getDefaultDumpPath(options?: PathResolutionOptions): string {
  return path.join(getGlobalConfigDir(options), "expanded-config.json")
}
