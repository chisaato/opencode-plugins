import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildAttachCommand, createMuxClient, createMuxManager, createMuxState, detectMuxBackend,
  MuxCommandError, MuxError, projectMuxSession, resolveMuxStateDir, stripAnsi, wrapShellCommand,
} from "../src"
import type { CommandResult, CommandRunner } from "../src"

interface MockPane {
  fields: Record<string, string>
  output: string
}

function fakeMux() {
  const panes = new Map<string, MockPane>()
  const calls: string[][] = []
  let serial = 0
  let pid = 100
  let listError: string | undefined
  const killErrors = new Map<string, string>()
  let ignoreInterrupt = false
  let cancelledWaits = 0
  const result = (stdout = "", exitCode = 0, stderr = ""): CommandResult => ({ exitCode, stdout, stderr })
  const runner: CommandRunner = async (file, cli, options) => {
    calls.push([file, ...cli])
    const args = cli[0] === "-L" ? cli.slice(2) : cli
    const [command] = args
    const target = args[args.indexOf("-t") + 1]
    const pane = panes.get(target)
    switch (command) {
      case "-V": return result("mux mock")
      case "list-panes":
        if (listError) return result("", 1, listError)
        return result([...panes.values()].map(({ fields }) => args.at(-1)!.replace(/#\{([^}]+)}/g,
          (_, key: string) => fields[key] ?? "")).join("\n"))
      case "new-session":
      case "new-window": {
        const session = command === "new-session" ? args[args.indexOf("-s") + 1] : target.slice(0, -1)
        if (command === "new-session" && [...panes.values()].some(({ fields }) => fields.session_name === session)) {
          return result("", 1, `duplicate session: ${session}`)
        }
        const id = `%${serial++}`
        panes.set(id, {
          fields: { pane_id: id, session_name: session, window_index: "0", window_name: "window",
            pane_current_path: args[args.indexOf("-c") + 1], pane_dead: "0", pane_pid: String(pid++) },
          output: "",
        })
        return result(`${id}\n`)
      }
      case "set-option":
        if (args[1] !== "-p") return result()
        if (!pane) return result("", 1, "can't find pane")
        for (let i = 0; i < args.length; i += 7) pane.fields[args[i + 4]] = args[i + 5]
        return result()
      case "bind-key":
      case "set-hook": return result()
      case "list-keys": return result("", 1, "table does not exist")
      case "respawn-pane": {
        if (!pane) return result("", 1, "can't find pane")
        const script = args.at(-1)!
        if (script.includes("invalid respawn")) return result("", 1, "respawn failed")
        const exit = script.match(/exit (\d+)/)
        pane.fields.pane_pid = String(pid++)
        pane.fields.pane_dead = exit ? "1" : "0"
        pane.fields.pane_dead_status = exit?.[1] ?? ""
        pane.output = `\x1b[32mfirst\x1b[0m\nsecond\n`
        return result()
      }
      case "capture-pane": return pane ? result(pane.output) : result("", 1, "can't find pane")
      case "send-keys":
        if (pane && args.at(-1) === "C-c" && !args.includes("-l") && !ignoreInterrupt) {
          pane.fields.pane_dead = "1"
          pane.fields.pane_dead_status = "130"
        }
        return result()
      case "kill-pane": {
        const error = killErrors.get(target)
        if (error) return result("", 1, error)
        panes.delete(target)
        return result()
      }
      case "kill-session": {
        const name = target.slice(1)
        const ids = [...panes.keys()].filter((id) => panes.get(id)?.fields.session_name === name)
        if (!ids.length) return result("", 1, `can't find session: ${target}`)
        for (const id of ids) panes.delete(id)
        return result()
      }
      case "wait-for":
        return new Promise((done) => {
          options?.signal?.addEventListener("abort", () => { cancelledWaits++; done(result("", 1)) }, { once: true })
        })
      default: throw new Error(`Unexpected mux call: ${args.join(" ")}`)
    }
  }
  return {
    calls, runner, panes, killErrors, listError: (error?: string) => { listError = error },
    ignoreInterrupt: () => { ignoreInterrupt = true },
    get cancelledWaits() { return cancelledWaits },
  }
}

describe("mux manager", () => {
  let dir: string
  let fake: ReturnType<typeof fakeMux>
  let manager: ReturnType<typeof createMuxManager>
  const identity = { cwd: join(tmpdir(), "mux-core"), name: "dev" }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-mux-unit-"))
    vi.stubEnv("OPENCODE_MUX_STATE_DIR", dir)
    fake = fakeMux()
    manager = createMuxManager({ runner: fake.runner, backend: { kind: "tmux", platform: "linux" }, pollIntervalMs: 5 })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it("lists manual panes with session and cwd filters, adopts once, and preserves intended commands on input restart", async () => {
    fake.panes.set("%900", { fields: {
      pane_id: "%900", session_name: "manual", pane_pid: "999999999", pane_current_path: identity.cwd,
      pane_current_command: "sleep", pane_dead: "0",
    }, output: "" })
    expect(await manager.listPanes()).toEqual([])
    expect(await manager.listPanes({ all: true, cwd: identity.cwd })).toHaveLength(1)
    expect(await manager.listPanes({ all: true, cwd: dir })).toEqual([])
    const task = await manager.adoptPane({ paneId: "%900", name: "adopted", command: "sleep 60" })
    expect(task).toMatchObject({ paneId: "%900", name: "adopted", command: "sleep 60", status: "running" })
    expect(await manager.adoptPane({ paneId: "%900" })).toEqual(task)
    expect(await manager.listTasks({ name: "adopted" })).toHaveLength(1)
    const calls = fake.calls.length
    expect(await manager.restartTask(task.id, { mode: "input", command: "echo restarted" })).toMatchObject({
      ok: true, task: { command: "sleep 60", paneId: "%900", restartCount: 0 },
    })
    expect(fake.calls.slice(calls).filter((call) => call.includes("send-keys")).map((call) => call.slice(1))).toEqual([
      ["send-keys", "-t", "%900", "C-c"],
      ["send-keys", "-t", "%900", "-l", "--", "echo restarted"],
      ["send-keys", "-t", "%900", "Enter"],
    ])
    expect(fake.calls.slice(calls).some((call) => call.includes("respawn-pane") || call.includes("new-window"))).toBe(false)
    await expect(manager.restartTask(task.id, { mode: "input" })).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
    await expect(manager.adoptPane({ paneId: "%missing" })).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
  })

  async function writeExitMarker(task: { id: string; paneId: string; panePid?: number }) {
    const prefix = await createMuxState().prepareExitFile(task.paneId, task.id)
    const marker = `${prefix}${task.panePid}.txt`
    await writeFile(marker, "1\n")
    return marker
  }

  async function historyTask(name: string, { cwd = identity.cwd, command = "exit 0", ageDays = 8 } = {}) {
    const { task } = await manager.runBuild({ cwd, name, command, wait: false })
    const aged = { ...task, updatedAt: new Date(Date.now() - ageDays * 86_400_000).toISOString() }
    await createMuxState().writeTask(aged)
    return aged
  }

  it("预览和确认仅清理项目内已过期的终态及无 pane 的记录", async () => {
    const old = await historyTask("old")
    const recent = await historyTask("recent", { ageDays: 6 })
    const running = await historyTask("running", { command: "sleep 60" })
    const other = await historyTask("other", { cwd: join(dir, "other-project") })
    const gone = await historyTask("gone", { ageDays: 0 })
    // 原 pane ID 现在属于手工 pane，而非预览对象。
    const manual = fake.panes.get(gone.paneId)!
    for (const key of Object.keys(manual.fields)) {
      if (key.startsWith("@opencode_mux_")) delete manual.fields[key]
    }
    const marker = await writeExitMarker(gone)
    const options = { cwd: identity.cwd }
    const candidates = await manager.previewHistory(options)
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: gone.id, status: "gone" }),
      expect.objectContaining({ id: old.id, status: "succeeded", updatedAt: old.updatedAt }),
    ]))
    expect(candidates).toHaveLength(2)
    expect(await manager.previewHistory(options)).toEqual(candidates)
    expect(fake.calls.some((call) => call.includes("kill-pane"))).toBe(false)
    expect(await readFile(marker, "utf8")).toBe("1\n")
    expect((await manager.previewHistory({ ...options, retentionDays: 0 })).map(({ id }) => id)).toContain(recent.id)

    expect(await manager.cleanHistory({ ...options, candidates })).toEqual({
      removed: candidates.map(({ id }) => id), skipped: [], failed: [],
    })
    expect(fake.calls.filter((call) => call.includes("kill-pane"))).toEqual([["tmux", "kill-pane", "-t", old.paneId]])
    expect(fake.calls.some((call) => call.includes("kill-session"))).toBe(false)
    expect([...fake.panes.keys()]).toEqual([recent.paneId, running.paneId, other.paneId, gone.paneId])
    expect((await createMuxState().listTasks()).map(({ id }) => id).sort()).toEqual([recent.id, running.id, other.id].sort())
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("驻留 shell 只有在预览和实际清理均显式允许时才会关闭", async () => {
    const original = await historyTask("shell", { command: "sleep 60" })
    const marker = await writeExitMarker(original)
    const [shell] = await manager.listTasks({ cwd: identity.cwd })
    const candidate = { ...shell, updatedAt: original.updatedAt }
    await createMuxState().writeTask(candidate)
    const options = { cwd: identity.cwd }
    expect(await manager.previewHistory(options)).toEqual([])
    const candidates = await manager.previewHistory({ ...options, includeShell: true })
    expect(candidates).toEqual([expect.objectContaining({ id: shell.id, status: "failed", shell: true })])
    expect(await manager.cleanHistory({ ...options, candidates })).toEqual({
      removed: [], skipped: [shell.id], failed: [],
    })
    expect(fake.panes.has(shell.paneId)).toBe(true)
    expect(await manager.cleanHistory({ ...options, candidates, includeShell: true })).toEqual({
      removed: [shell.id], skipped: [], failed: [],
    })
    expect(fake.panes.has(shell.paneId)).toBe(false)
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("确认时跳过已经重启、移动、身份被替换或证据不符的任务", async () => {
    const restarted = await historyTask("restarted")
    const moved = await historyTask("moved")
    const reused = await historyTask("reused")
    const revived = await historyTask("revived")
    const ambiguous = await historyTask("ambiguous")
    const changed = await historyTask("changed")
    const movedProject = await historyTask("moved-project")
    const options = { cwd: identity.cwd, retentionDays: 0 }
    const candidates = await manager.previewHistory(options)
    expect(candidates).toHaveLength(7)
    await manager.restartTask(restarted.id, { command: "exit 42" })
    fake.panes.get(moved.paneId)!.fields.session_name = projectMuxSession(join(dir, "moved"))
    fake.panes.get(reused.paneId)!.fields["@opencode_mux_id"] = "manually-replaced"
    Object.assign(fake.panes.get(revived.paneId)!.fields, { pane_dead: "0", pane_pid: "9900" })
    const linked = fake.panes.get(ambiguous.paneId)!
    fake.panes.set("%777", { ...linked, fields: { ...linked.fields, pane_id: "%777" } })
    fake.panes.get(changed.paneId)!.fields.pane_dead_status = "42"
    const state = createMuxState()
    await state.writeTask({ ...movedProject, cwd: join(dir, "moved-project") })

    expect(await manager.cleanHistory({ ...options, candidates })).toEqual({
      removed: [], skipped: candidates.map(({ id }) => id), failed: [],
    })
    expect(await state.listTasks()).toHaveLength(7)
    expect(fake.calls.some((call) => call.includes("kill-pane"))).toBe(false)
  })

  it("单项清理失败后继续处理后续候选；重复候选只尝试一次", async () => {
    const blocked = await historyTask("blocked")
    const removable = await historyTask("removable")
    const options = { cwd: identity.cwd }
    await manager.previewHistory(options)
    fake.killErrors.set(blocked.paneId, "permission denied")
    expect(await manager.cleanHistory({ ...options, candidates: [blocked, blocked, removable] })).toEqual({
      removed: [removable.id], skipped: [], failed: [{ id: blocked.id, message: expect.stringContaining("permission denied") }],
    })
    expect(fake.panes.has(blocked.paneId)).toBe(true)
    expect(await createMuxState().readTask(blocked.id)).toEqual(blocked)
    expect(await createMuxState().readTask(removable.id)).toBeUndefined()
  })

  it("保留后端探测的 null 契约，由管理器返回错误码", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "" })
    await expect(detectMuxBackend({ runner })).resolves.toBeNull()
    const result = createMuxManager({ runner }).getBackend()
    await expect(result).rejects.toBeInstanceOf(MuxError)
    await expect(result).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" })
  })

  it("日志和输入对缺少存活窗格的任务返回错误码", async () => {
    await expect(manager.captureLogs("missing-task")).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
    await expect(manager.sendInput("missing-task", "x")).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
  })

  it.each([false, true])("移除构建及哨兵，pane 已消失：%s", async (missingPane) => {
    const { task } = await manager.runBuild({ ...identity, command: "sleep 60", wait: false })
    const marker = await writeExitMarker(task)
    if (missingPane) fake.panes.delete(task.paneId)
    expect(await manager.removeTask(task.id)).toMatchObject({ ok: true, task: { id: task.id, role: "build" } })
    expect(fake.panes.has(task.paneId)).toBe(false)
    expect(await createMuxState().readTask(task.id)).toBeUndefined()
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([false, true])("关闭项目会话并只清理该会话的任务，目标已消失：%s", async (missingSession) => {
    const { task: build } = await manager.runBuild({ ...identity, command: "sleep 60", wait: false })
    const { task: service } = await manager.serviceAction({ ...identity, action: "start", command: "sleep 60" })
    const { task: other } = await manager.runBuild({ ...identity, cwd: join(dir, "other"), command: "sleep 60", wait: false })
    const markers = await Promise.all([writeExitMarker(build), writeExitMarker(service!), writeExitMarker(other)])
    if (missingSession) {
      fake.panes.delete(build.paneId)
      fake.panes.delete(service!.paneId)
    }

    const sessionName = projectMuxSession(identity.cwd)
    expect(await manager.closeSession({ cwd: identity.cwd })).toEqual({ ok: true, removed: 2, sessionName })
    expect(fake.calls).toContainEqual(["tmux", "kill-session", "-t", `=${sessionName}`])
    expect([...fake.panes.keys()]).toEqual([other.paneId])
    expect((await createMuxState().listTasks()).map(({ id }) => id)).toEqual([other.id])
    for (const marker of markers.slice(0, 2)) await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(markers[2], "utf8")).toBe("1\n")
    expect(await manager.closeSession({ cwd: identity.cwd })).toEqual({ ok: true, removed: 0, sessionName })
  })

  it("returns fast build results, reuses the same pane, and captures a clean bounded tail", async () => {
    const first = await manager.runBuild({ ...identity, command: "echo ok; exit 0", tailLines: 1, sessionId: "ses_1" })
    expect(first).toMatchObject({ ok: true, timedOut: false, tail: "second", task: { status: "succeeded", exitCode: 0 } })
    expect(first.task.muxSession).toMatch(/^oc-mux-core-[0-9a-f]{8}$/)
    const second = await manager.runBuild({ ...identity, command: "exit 42" })
    expect(second).toMatchObject({
      ok: false, tail: "first\nsecond", task: {
        id: first.task.id, paneId: first.task.paneId, status: "failed", exitCode: 42,
        restartCount: 1, sessionId: "ses_1",
      },
    })
    expect(await manager.listTasks({ role: "build", cwd: identity.cwd, sessionId: "ses_1" })).toHaveLength(1)
    expect(fake.panes.get(second.task.paneId)?.fields["@opencode_mux_cmd"]).toBe("exit 42")
  })

  it("supports asynchronous builds, poll fallback and timeout cancellation", async () => {
    const running = await manager.runBuild({ ...identity, command: "sleep 1", wait: false })
    expect(running).toMatchObject({ ok: true, tail: "", timedOut: false, task: { status: "running" } })
    expect(fake.calls.some(([, subcommand]) => subcommand === "wait-for")).toBe(false)
    const completed = manager.runBuild({ ...identity, command: "sleep 1", timeoutMs: 2_000 })
    await vi.waitFor(() => expect(fake.calls.some(([, command]) => command === "wait-for")).toBe(true))
    const pane = fake.panes.get(running.task.paneId)!
    Object.assign(pane.fields, { pane_dead: "1", pane_dead_status: "0" })
    expect(await completed).toMatchObject({ ok: true, task: { exitCode: 0 } })
    const timeout = await manager.runBuild({ ...identity, command: "sleep 1", timeoutMs: 35 })
    expect(timeout).toMatchObject({ ok: false, timedOut: true, task: { status: "running" } })
    expect(fake.cancelledWaits).toBe(2)
  })

  it("starts, stops, restarts and removes a service; literal input is not parsed as key names", async () => {
    const service = { ...identity, command: "sleep 60" }
    const started = (await manager.serviceAction({ ...service, action: "start" })).task!
    expect(started).toMatchObject({ role: "service", status: "running", restartCount: 0 })
    expect((await manager.serviceAction({ ...service, action: "start" })).task).toEqual(started)
    await manager.sendInput(started.id, "C-c", { enter: true })
    expect(fake.calls).toContainEqual(["tmux", "send-keys", "-t", started.paneId, "-l", "--", "C-c"])
    expect(fake.calls).toContainEqual(["tmux", "send-keys", "-t", started.paneId, "Enter"])
    const restarted = (await manager.serviceAction({ ...service, action: "start", restartIfRunning: true })).task!
    expect(restarted).toMatchObject({ id: started.id, paneId: started.paneId, restartCount: 1 })
    expect(await manager.serviceAction({ ...identity, action: "stop" })).toMatchObject({
      ok: true, task: { status: "stopped", exitCode: 130 },
    })
    await expect(manager.sendInput(started.id, "anything")).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
    expect(await manager.captureLogs(started.id, 1)).toBe("second")
    expect(await manager.serviceAction({ ...identity, action: "start" })).toMatchObject({
      ok: true, task: { status: "running", paneId: started.paneId, restartCount: 2 },
    })
    expect(await manager.restartTask(started.id, { command: "exit 42" })).toMatchObject({
      ok: true, task: { status: "failed", exitCode: 42, restartCount: 3 },
    })
    expect(await manager.serviceAction({ ...identity, action: "restart" })).toMatchObject({
      task: { paneId: started.paneId, restartCount: 4 },
    })
    expect(await manager.removeTask(started.id)).toMatchObject({ ok: true })
    expect(fake.panes.size).toBe(0)
    expect(await manager.serviceAction({ ...identity, action: "status" })).toMatchObject({ ok: false })
  })

  it("reconciles and adopts panes changed directly by the user, then prunes only gone tasks", async () => {
    const started = (await manager.serviceAction({ ...identity, action: "start", command: "sleep 60", sessionId: "ses_2" })).task!
    const state = createMuxState()
    await state.deleteTask(started.id)
    const [adopted] = await manager.listTasks()
    expect(adopted).toMatchObject({ id: started.id, name: identity.name, command: "sleep 60", sessionId: "ses_2" })
    const pane = fake.panes.get(started.paneId)!
    Object.assign(pane.fields, { pane_dead: "1", pane_dead_status: "42" })
    expect(await manager.listTasks()).toMatchObject([{ status: "failed", exitCode: 42 }])
    Object.assign(pane.fields, { pane_dead: "0", pane_pid: "200" })
    expect(await manager.listTasks()).toMatchObject([{ status: "running", restartCount: 1, panePid: 200 }])
    delete pane.fields["@opencode_mux_id"]
    expect(await manager.listTasks()).toMatchObject([{ status: "gone" }])
    expect(await manager.pruneGone()).toMatchObject([{ id: started.id }])
    expect(await state.readTask(started.id)).toBeUndefined()
    expect(fake.panes.has(started.paneId)).toBe(true)
  })

  it("reports stop timeout without killing, or force-stops and recreates a missing pane", async () => {
    fake.ignoreInterrupt()
    const started = (await manager.serviceAction({ ...identity, action: "start", command: "sleep 60" })).task!
    expect(await manager.stopTask(started.id, { timeoutMs: 0 })).toMatchObject({
      ok: false, timedOut: true, task: { status: "running" },
    })
    expect(await manager.stopTask(started.id, { timeoutMs: 0, force: true })).toMatchObject({
      ok: true, task: { status: "stopped" },
    })
    expect(await manager.listTasks()).toMatchObject([{ status: "stopped" }])
    const next = (await manager.serviceAction({ ...identity, action: "start" })).task!
    expect(next.paneId).not.toBe(started.paneId)
    expect(next).toMatchObject({ id: started.id, restartCount: 1, status: "running" })
  })

  it("handles absent servers but never marks tasks gone after unexpected mux errors", async () => {
    await expect(manager.serviceAction({ ...identity, action: "start" })).rejects.toMatchObject({ code: "COMMAND_REQUIRED" })
    await expect(manager.runBuild({ ...identity, command: " " })).rejects.toThrow("non-empty")
    await expect(manager.runBuild({ ...identity, command: "exit 0", timeoutMs: -1 })).rejects.toThrow(RangeError)
    await expect(manager.runBuild({ ...identity, command: "invalid respawn" })).rejects.toThrow(MuxCommandError)
    expect(fake.panes.size).toBe(0)
    const task = (await manager.runBuild({ ...identity, command: "sleep 60", wait: false })).task
    const state = createMuxState()
    fake.listError("permission denied")
    await expect(manager.listTasks()).rejects.toThrow("permission denied")
    expect(await state.readTask(task.id)).toMatchObject({ status: "running" })
    fake.listError("error connecting to /tmp/socket (No such file or directory)")
    expect(await manager.listTasks()).toMatchObject([{ status: "gone" }])
    await expect(state.readTask("../invalid")).rejects.toThrow("Invalid mux task id")
  })

  it("keeps backend/socket scope separate and constructs Windows psmux commands", async () => {
    const windows = createMuxManager({ runner: fake.runner, platform: "win32", socketName: "test mux" })
    expect(await detectMuxBackend({ runner: fake.runner, platform: "win32" })).toMatchObject({ kind: "psmux" })
    const task = (await windows.runBuild({ ...identity, command: "exit 42" })).task
    expect(task).toMatchObject({ muxKind: "psmux", socketName: "test mux", status: "failed", exitCode: 42 })
    const command = fake.calls.find((call) => call.includes("respawn-pane"))!
    expect(command.slice(0, 4)).toEqual(["psmux", "-L", "test mux", "respawn-pane"])
    expect(command).toContain("cmd.exe")
    expect(command.at(-1)).toContain('"psmux" "-L" "test mux" "wait-for" "-S"')
    expect(command.at(-1)).toContain("exit /b !__oc_rc!")
    expect(fake.calls).toContainEqual(["psmux", "-L", "test mux", "set-option", "-t", task.muxSession, "status-right", "#S + %Y-%m-%d + %H:%M:%S"])
    expect(wrapShellCommand({ kind: "psmux" }, 'echo "%PATH%"', "wake"))
      .toEqual(["cmd.exe", "/d", "/c", 'echo "%PATH%"'])
    expect(await manager.listTasks()).toEqual([])
    expect(await windows.attachCommand(task)).toContain(`"attach-session" "-t" "=${task.muxSession}"`)
  })
})

describe("backend and state helpers", () => {
  it("quotes Unix commands and derives state paths by precedence", async () => {
    const backend = { kind: "tmux", socketName: "O'Reilly", platform: "linux" } as const
    expect(wrapShellCommand(backend, "exit 3")).toEqual(["sh", "-lc", "exit 3"])
    expect(wrapShellCommand(backend, "exit 3", "done")[2]).toContain(`'O'\\''Reilly'`)
    expect(buildAttachCommand(backend, "hello")).toContain(`'-t' '=hello'`)
    expect(stripAnsi("\x1b]8;;https://example.test\x1b\\\x1b[32mhello\x1b[0m\x1b]8;;\x07")).toBe("hello")
    expect(resolveMuxStateDir({ OPENCODE_MUX_STATE_DIR: "custom", XDG_STATE_HOME: "xdg" }, "home")).toBe("custom")
    expect(resolveMuxStateDir({ XDG_STATE_HOME: "xdg" }, "home")).toBe(join("xdg", "opencode-mux"))
    expect(resolveMuxStateDir({}, "home")).toBe(join("home", ".local", "state", "opencode-mux"))
  })

  it("驻留 shell 会把执行的命令注入自身历史，支持按 Up 调出", () => {
    const backend = { kind: "tmux", platform: "linux" } as const
    const script = wrapShellCommand(backend, "echo hello-world", undefined, "/tmp/oc-exit-")[2]
    // 命令原文通过环境变量传给交互 shell，避免引号/换行转义问题。
    expect(script).toContain("__oc_hist_cmd='echo hello-world'")
    // zsh / bash 分别用自身历史 API 注入，不直接改写 HISTFILE。
    expect(script).toContain(`print -s -- "$__OC_HIST_CMD"`)
    expect(script).toContain(`history -s -- "$__OC_HIST_CMD"`)
    expect(script).toContain("precmd_functions+=(__oc_mux_inject_history)")
    expect(script).toContain("PROMPT_COMMAND+=(__oc_mux_inject_history)")
    // 注入只发生一次：hook 运行时把自己从 precmd/PROMPT_COMMAND 移除。
    expect(script).toContain("precmd_functions=(${precmd_functions:#__oc_mux_inject_history})")
    expect(script).toContain("unset -f __oc_mux_inject_history")
    // 临时 rc 目录会在首个 prompt 时被清理，不残留。
    expect(script).toContain("rm -rf \"$__OC_HIST_DIR\"")
  })

  it("propagates external cancellation to a waiting mux client", async () => {
    const fake = fakeMux()
    const mux = createMuxClient({ kind: "tmux" }, fake.runner)
    const controller = new AbortController()
    const waiting = mux.waitForChannel("test", { timeoutMs: 10_000, signal: controller.signal })
    controller.abort()
    expect(await waiting).toBe(false)
    expect(fake.cancelledWaits).toBe(1)
  })
})
