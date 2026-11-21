import os from "node:os"
import path from "node:path"

export const CONFIG_FILENAMES = ["model-prompts.jsonc", "model-prompts.json"] as const
export const PROMPTS_DIR_NAME = "model-prompts"

export interface PathResolutionOptions {
  projectDirectory?: string
  homeDirectory?: string
}

/** 全局目录优先使用显式 HOME，再使用测试 HOME、XDG，最后使用系统 HOME。 */
export function getGlobalConfigDir(options?: PathResolutionOptions): string {
  if (options?.homeDirectory) return path.join(options.homeDirectory, ".config", "opencode")
  if (process.env.OPENCODE_TEST_HOME) return path.join(process.env.OPENCODE_TEST_HOME, ".config", "opencode")
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

export function resolveUserPath(target: string): string {
  if (target === "~" || target.startsWith("~/")) {
    return path.resolve(process.env.HOME ?? os.homedir(), target.slice(2))
  }
  return path.resolve(target)
}

export function getDefaultConfigPaths(options?: PathResolutionOptions): string[] {
  return CONFIG_FILENAMES.map((name) => path.join(getGlobalConfigDir(options), name))
}

export function getProjectConfigCandidateGroups(projectDirectory: string): string[][] {
  return [
    CONFIG_FILENAMES.map((name) => path.join(projectDirectory, ".opencode", name)),
    CONFIG_FILENAMES.map((name) => path.join(projectDirectory, name)),
  ]
}
