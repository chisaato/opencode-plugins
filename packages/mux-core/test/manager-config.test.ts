import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createMuxManager, type CommandRunner } from "../src"

const { home } = vi.hoisted(() => ({ home: { path: "" } }))
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>()
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: home.path }) }
})

it("routes both Mux entry points to the host-configured tmux socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-mux-manager-config-"))
  try {
    home.path = dir
    const configDir = join(dir, ".config", "opencode")
    await mkdir(configDir, { recursive: true })
    const tmuxConfig = join(configDir, "tmux.conf")
    await writeFile(tmuxConfig, "set -g status-left custom\n")
    await writeFile(join(configDir, "opencode-mux.json"), JSON.stringify({ socketName: "mux-host-theme" }))
    const runner = vi.fn<CommandRunner>().mockResolvedValue({ exitCode: 0, stdout: "tmux 3.8\n", stderr: "" })
    const host = createMuxManager({ stateDir: dir, platform: "linux", runner })
    const plugin = createMuxManager({ stateDir: dir, platform: "linux", runner, socketName: "workspace-socket" })

    const backend = { kind: "tmux", socketName: "mux-host-theme", tmuxConfig }
    await expect(host.getBackend()).resolves.toMatchObject(backend)
    await expect(plugin.getBackend()).resolves.toMatchObject(backend)
    const target = { muxSession: "oc-project" }
    const attach = await host.attachCommand(target)
    expect(await plugin.attachCommand(target)).toBe(attach)
    expect(attach).toContain("'-L' 'mux-host-theme'")
    expect(attach).not.toContain("'-f'")
    expect(runner.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["tmux", ["-V"]],
      ["tmux", ["-V"]],
    ])
  } finally {
    home.path = ""
    await rm(dir, { recursive: true, force: true })
  }
})
