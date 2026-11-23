import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildAttachCommand, detectMuxBackend, muxCommandArgs } from "../src/backend"
import { resolveMuxConfig, validateTmuxBackendConfig } from "../src/config"
import type { MuxBackend } from "../src/types"

describe("explicit host tmux.conf", () => {
  let dir: string
  let config: string
  const socketName = "oc-host"

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-mux-config-"))
    config = join(dir, "host config.conf")
    await writeFile(config, "# test config\n")
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  function configPath(home: string) {
    return join(home, ".config", "opencode", "opencode-mux.json")
  }

  async function writeUserConfig(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  it("uses the OS home pair rather than the workspace socket or environment", async () => {
    const options = { socketName: "workspace" }
    const workspace = join(dir, "workspace")
    vi.stubEnv("HOME", workspace)
    vi.stubEnv("XDG_CONFIG_HOME", join(workspace, ".config"))
    vi.stubEnv("OPENCODE_MUX_TMUX_CONFIG", config)
    vi.stubEnv("OPENCODE_MUX_SOCKET_NAME", "from-env")
    await writeUserConfig(configPath(workspace), JSON.stringify({ tmuxConfig: config, socketName: "injected" }))
    await expect(resolveMuxConfig(options, dir)).resolves.toEqual({ ...options, tmuxConfig: undefined })
    await expect(resolveMuxConfig(options, relative(process.cwd(), workspace))).resolves.toEqual({
      ...options, tmuxConfig: undefined,
    })
    await writeUserConfig(configPath(dir), JSON.stringify({ tmuxConfig: config, socketName }))
    await expect(resolveMuxConfig(options, dir)).resolves.toEqual({ tmuxConfig: config, socketName })
  })

  it.each([
    ["{", /valid JSON/],
    [JSON.stringify({ tmuxConfig: "", socketName }), /requires tmuxConfig/],
    [JSON.stringify({ tmuxConfig: null, socketName }), /requires tmuxConfig/],
    [JSON.stringify({ tmuxConfig: "/host.conf" }), /requires a dedicated, non-default socketName/],
    [JSON.stringify({ tmuxConfig: "/host.conf", socketName: "default" }), /requires a dedicated, non-default socketName/],
  ])("fails closed for invalid user config: %s", async (content, error) => {
    await writeUserConfig(configPath(dir), content)
    await expect(resolveMuxConfig({ tmuxConfig: config, socketName }, dir)).rejects.toThrow(error)
  })

  it.each([undefined, "themes/custom.conf"])("resolves tmux.conf from the OpenCode config directory: %s", async (tmuxConfig) => {
    const path = configPath(dir)
    await writeUserConfig(path, JSON.stringify({ socketName, tmuxConfig }))
    await expect(resolveMuxConfig({}, dir)).resolves.toEqual({
      socketName,
      tmuxConfig: join(dirname(path), tmuxConfig ?? "tmux.conf"),
    })
  })

  it("falls back to explicit core options only when the user config is absent", async () => {
    const options = { tmuxConfig: config, socketName }
    await expect(resolveMuxConfig(options, dir)).resolves.toEqual(options)
    await mkdir(configPath(dir), { recursive: true })
    await expect(resolveMuxConfig(options, dir)).rejects.toThrow("Could not read opencode/opencode-mux.json")
  })

  it.each([undefined, "", "default", "..", "../default", "nested/socket"])("rejects non-dedicated socket %s", async (socketName) => {
    await expect(validateTmuxBackendConfig({ kind: "tmux", platform: "linux", socketName, tmuxConfig: config }))
      .rejects.toThrow(/dedicated, non-default/)
  })

  it("rejects paths that are not absolute readable regular files", async () => {
    const backend = { kind: "tmux", platform: "linux", socketName } as const
    await expect(validateTmuxBackendConfig({ ...backend, tmuxConfig: "" })).rejects.toThrow(/absolute path/)
    await expect(validateTmuxBackendConfig({ ...backend, tmuxConfig: "tmux.conf" })).rejects.toThrow(/absolute path/)
    await expect(validateTmuxBackendConfig({ ...backend, tmuxConfig: join(dir, "missing") })).rejects.toThrow(/readable regular file/)
    await expect(validateTmuxBackendConfig({ ...backend, tmuxConfig: dir })).rejects.toThrow(/readable regular file/)
    await expect(validateTmuxBackendConfig({ ...backend, tmuxConfig: config })).resolves.toBeUndefined()
  })

  it("probes only tmux even when psmux is preferred, and rejects Windows and injected psmux", async () => {
    const runner = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" }))
    const options = { platform: "linux", preferred: "psmux", socketName, tmuxConfig: config } as const
    await expect(detectMuxBackend({ ...options, runner })).resolves.toBeNull()
    expect(runner.mock.calls).toEqual([["tmux", ["-V"], { timeoutMs: 2_000 }]])
    runner.mockClear()
    await expect(detectMuxBackend({ ...options, platform: "win32", runner })).rejects.toThrow(/non-Windows/)
    expect(runner).not.toHaveBeenCalled()
    await expect(validateTmuxBackendConfig({ ...options, kind: "psmux" })).rejects.toThrow(/requires tmux/)
  })

  it("adds -f as one path argument only for new-session", () => {
    const backend: MuxBackend = { kind: "tmux", platform: "linux", socketName, tmuxConfig: config }
    expect(muxCommandArgs(backend, ["new-session", "-d"])).toEqual(["-L", socketName, "-f", config, "new-session", "-d"])
    expect(muxCommandArgs(backend, ["new-window", "-d"])).toEqual(["-L", socketName, "new-window", "-d"])
    expect(muxCommandArgs(backend, ["list-panes"])).toEqual(["-L", socketName, "list-panes"])
    expect(buildAttachCommand(backend, "target")).toBe("'tmux' '-L' 'oc-host' 'attach-session' '-t' '=target'")
  })
})
