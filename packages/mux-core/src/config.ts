import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { MuxBackend, MuxManagerOptions } from "./types"

const openCodeConfigDir = "opencode"
const userConfigFile = "opencode-mux.json"
const userConfigName = `${openCodeConfigDir}/${userConfigFile}`

function absoluteDir(value: string | undefined): string | undefined {
  return value && isAbsolute(value) && !value.includes("\0") ? value : undefined
}

function userHome(): string | undefined {
  try {
    return userInfo().homedir
  } catch {
    return undefined
  }
}

async function readUserConfig(home: string | undefined) {
  const homeDir = absoluteDir(home)
  if (!homeDir) return undefined
  const configDir = join(homeDir, ".config", openCodeConfigDir)
  const path = join(configDir, userConfigFile)
  let content: string
  try {
    if (!(await stat(path)).isFile()) throw new Error("expected a regular file")
    content = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return undefined
    throw new Error(`Could not read ${userConfigName} (${code ?? "expected a regular file"})`)
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error(`${userConfigName} must contain valid JSON`)
  }
  const config = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const { tmuxConfig = "tmux.conf", socketName } = config
  if (typeof tmuxConfig !== "string" || !tmuxConfig.trim() || tmuxConfig.includes("\0")) {
    throw new Error(`${userConfigName} requires tmuxConfig to be a non-empty path`)
  }
  if (typeof socketName !== "string" || !isDedicatedSocketName(socketName)) {
    throw new Error(`${userConfigName} requires a dedicated, non-default socketName`)
  }
  return { tmuxConfig: isAbsolute(tmuxConfig) ? tmuxConfig : resolve(configDir, tmuxConfig), socketName }
}

export async function resolveMuxConfig(options: MuxManagerOptions, home = userHome()) {
  // 运行时可能从项目 .env 加载 HOME/XDG_CONFIG_HOME；不允许项目重定向宿主配置。
  const userConfig = await readUserConfig(home)
  if (userConfig) return userConfig
  return {
    tmuxConfig: options.tmuxConfig ?? options.backend?.tmuxConfig,
    socketName: options.socketName ?? options.backend?.socketName,
  }
}

function isDedicatedSocketName(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" && !/^\.{1,2}$|^default$|[\\/\x00-\x1f\x7f]/i.test(value)
}

export function assertTmuxConfigTarget({ kind, platform = process.platform, socketName, tmuxConfig }: MuxBackend): void {
  if (tmuxConfig === undefined) return
  if (kind !== "tmux" || platform === "win32") {
    throw new Error("An explicit tmux.conf requires tmux on a non-Windows host")
  }
  if (!isDedicatedSocketName(socketName)) {
    throw new Error("An explicit tmux.conf requires a dedicated, non-default tmux socket name")
  }
  if (!isAbsolute(tmuxConfig) || tmuxConfig.includes("\0")) {
    throw new Error("tmux.conf must be specified by an absolute path")
  }
}

export async function validateTmuxBackendConfig(backend: MuxBackend): Promise<void> {
  assertTmuxConfigTarget(backend)
  const path = backend.tmuxConfig
  if (path === undefined) return
  try {
    if ((await stat(path)).isFile()) {
      await access(path, constants.R_OK)
      return
    }
  } catch (cause) {
    throw new Error(`tmux.conf must be a readable regular file: ${path}`, { cause })
  }
  throw new Error(`tmux.conf must be a readable regular file: ${path}`)
}
