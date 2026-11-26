import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandRunner } from "@misakacloud/opencode-mux-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import mux, { createMuxTools, MuxPlugin, parseMuxOptions } from "../index"

const { runner } = vi.hoisted(() => ({ runner: vi.fn<CommandRunner>() }))

// 仅替换复用器命令执行；管理器、状态文件和工具注册走真实实现。
vi.mock(import("@misakacloud/opencode-mux-core"), async (original) => {
  const core = await original()
  return {
    ...core,
    createMuxManager: (options: Parameters<typeof core.createMuxManager>[0]) => core.createMuxManager({ ...options, runner }),
  }
})

type Transform = Parameters<typeof MuxPlugin.setup>[0]["tool"]["transform"]
type Editor = Parameters<Parameters<Transform>[0]>[0]
type RegisteredTool = ReturnType<typeof createMuxTools>[number]

function registry(...existing: RegisteredTool[]) {
  const tools = [...existing]
  const add = vi.fn((tool: RegisteredTool) => { tools.push(tool) })
  const editor = { list: () => tools, add } as unknown as Editor
  return { tools, add, editor }
}

function host(reg: ReturnType<typeof registry>) {
  let callback: Parameters<Transform>[0] | undefined
  const transform: Transform = vi.fn(async (apply) => {
    callback = apply
    apply(reg.editor)
    return { dispose: async () => {} }
  })
  return { transform, reload: (editor = reg.editor) => callback!(editor) }
}

beforeEach(() => { runner.mockReset() })

describe("插件入口", () => {
  it("以普通 V2 对象默认导出；同一注册表多次 transform 保持幂等", async () => {
    expect(mux).toBe(MuxPlugin)
    expect(mux.id).toBe("opencode-mux")
    const existing: RegisteredTool = {
      name: "mux_logs", description: "existing", input: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { content: [], metadata: {} } },
    }
    const reg = registry(existing)
    const h = host(reg)
    await mux.setup({ tool: h })
    h.reload()
    h.reload()
    expect(h.transform).toHaveBeenCalledTimes(1)
    expect(reg.add).toHaveBeenCalledTimes(9)
    expect(reg.tools.find(({ name }) => name === "mux_logs")).toBe(existing)
    expect(reg.tools.map(({ name }) => name).sort()).toEqual([
      "mux_adopt", "mux_clean_history", "mux_input", "mux_list", "mux_logs", "mux_panes", "mux_remove", "mux_restart", "mux_run_build", "mux_service",
    ])
    const fresh = registry()
    h.reload(fresh.editor)
    h.reload(fresh.editor)
    expect(fresh.add).toHaveBeenCalledTimes(10)
    for (const tool of fresh.tools) {
      expect(tool.input).toMatchObject({ type: "object", additionalProperties: false })
      expect(tool).not.toHaveProperty("output")
    }
    expect(fresh.tools.find(({ name }) => name === "mux_run_build")?.input.required).toEqual(["name", "command"])
    expect(runner).not.toHaveBeenCalled()
  })

  it("解析支持的内联配置，并保留有效的零值", () => {
    expect(parseMuxOptions({
      preferred: "psmux", socketName: "dev", stateDir: "state", keepShellOnExit: false, byobuKeys: true,
      statusTheme: "ascii", defaultTimeoutMs: 0, defaultTailLines: 5, unused: true,
    })).toEqual({
      preferred: "psmux", socketName: "dev", stateDir: "state", keepShellOnExit: false, byobuKeys: true,
      statusTheme: "ascii", defaultTimeoutMs: 0, defaultTailLines: 5,
    })
    expect(Object.values(parseMuxOptions({
      preferred: "screen", socketName: " ", stateDir: 1, keepShellOnExit: "false", byobuKeys: 1,
      statusTheme: "unknown", defaultTimeoutMs: -5, defaultTailLines: 2 ** 31,
    }))).toEqual(Array(8).fill(undefined))
    expect(parseMuxOptions(null)).toEqual(parseMuxOptions(undefined))
  })

  it("未提供 location 时使用 process.cwd()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-mux-test-"))
    try {
      runner.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" })
      const reg = registry()
      await mux.setup({ tool: host(reg), options: { stateDir: dir } })
      const result = await reg.tools.find(({ name }) => name === "mux_list")!.execute({})
      expect(result.metadata).toMatchObject({ cwd: process.cwd(), tasks: [], total: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("通过 setup 和真实核心运行构建、读取日志并列出持久化任务", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-mux-test-"))
    try {
      const metadata = new Map<string, string>()
      let sessionName: string | undefined
      let paneClosed = false
      const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
      runner.mockImplementation(async (exe, argv) => {
        expect(exe).toBe("tmux")
        if (argv[0] === "-V") return success("tmux 3.5")
        expect(argv.slice(0, 2)).toEqual(["-L", "test-socket"])
        const args = argv.slice(2)
        switch (args[0]) {
          case "list-panes": {
            if (!sessionName) return success()
            const fields: Record<string, string> = {
              session_name: sessionName, window_index: "0", window_name: "build", pane_id: "%1", pane_pid: "10",
              pane_current_path: dir, pane_current_command: "sh", pane_dead: paneClosed ? "1" : "0",
              pane_dead_status: paneClosed ? "0" : "", pane_title: "test",
            }
            return success(args[3].replace(/#\{([^}]+)\}/g, (_, field: string) => fields[field] ?? metadata.get(field) ?? ""))
          }
          case "new-session":
            sessionName = args[3]
            return success("%1\n")
          case "set-option":
            for (let i = 0; i < args.length; i += 7) metadata.set(args[i + 4], args[i + 5])
            return success()
          case "respawn-pane":
            paneClosed = true
            return success()
          case "wait-for":
            return success()
          case "capture-pane":
            expect(args.slice(1, 5)).toEqual(["-p", "-t", "%1", "-S"])
            return success("one\ntwo\nthree\n")
          default:
            throw new Error(`意外的复用器命令：${args.join(" ")}`)
        }
      })

      const reg = registry()
      await mux.setup({
        tool: host(reg), location: { directory: dir },
        options: {
          preferred: "tmux", socketName: "test-socket", stateDir: "state",
          byobuKeys: false, keepShellOnExit: false, statusTheme: "off", defaultTailLines: 2,
        },
      })
      expect(runner).not.toHaveBeenCalled()
      const call = (name: string, input: unknown) =>
        reg.tools.find((tool) => tool.name === name)!.execute(input, { sessionID: "ses_e2e" })

      const built = await call("mux_run_build", { name: "sample", command: "echo sample" })
      expect(built.metadata).toMatchObject({
        ok: true, status: "succeeded", exitCode: 0, paneId: "%1", tail: "two\nthree",
        attachCommand: expect.stringContaining("test-socket"),
      })
      const id = built.metadata.id
      const saved = JSON.parse(await readFile(join(dir, "state", "tasks", `${id}.json`), "utf8"))
      expect(saved).toMatchObject({ id, source: "ai", sessionId: "ses_e2e" })
      expect((await call("mux_logs", { id, lines: 1 })).metadata).toMatchObject({ logs: "three", exitCode: 0 })
      expect((await call("mux_list", {})).metadata).toMatchObject({
        cwd: dir, total: 1, tasks: [{ id, status: "succeeded", attachCommand: built.metadata.attachCommand }],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
