import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createCommandRunner, createMuxClient, createMuxManager, projectMuxSession } from "../src"
import type { CommandRunner, MuxBackend, MuxManager } from "../src"

const version = spawnSync("tmux", ["-V"], { encoding: "utf8" })
const absent = (version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"

describe.skipIf(absent)("real tmux on an isolated socket", () => {
  const socketName = `oc-mux-test-${randomUUID()}`
  const backend: MuxBackend = { kind: "tmux", socketName }
  const run = createCommandRunner()
  let dir: string
  let runner: CommandRunner
  let manager: MuxManager
  const tmux = (...args: string[]) => runner("tmux", ["-L", socketName, ...args])

  beforeAll(async () => {
    expect(version.error).toBeUndefined()
    expect(version.status).toBe(0)
    dir = await mkdtemp(join(tmpdir(), "oc-mux-real-"))
    const config = join(dir, "tmux.conf")
    const shellEnv = join(dir, "sh.env")
    await writeFile(shellEnv, 'PS1="mux-test> "\n')
    await writeFile(config, `set-option -g default-shell /bin/sh\nset-option -g mouse off\nset-environment -g ENV "${shellEnv}"\n`)
    runner = (file, args, options) => {
      if (file !== "tmux" || args[0] !== "-L" || args[1] !== socketName) {
        throw new Error("Integration tests may only access the isolated tmux server")
      }
      return run(file, ["-f", config, ...args], {
        ...options, env: { ...process.env, ...options?.env, HOME: dir, XDG_CONFIG_HOME: dir, TMUX_TMPDIR: dir, TMUX: undefined },
      })
    }
    manager = createMuxManager({ backend, runner, stateDir: dir, pollIntervalMs: 30 })
  })

  afterAll(async () => {
    if (!dir) return
    try {
      if (runner) {
        const result = await runner("tmux", ["-L", socketName, "kill-server"])
        if (result.exitCode !== 0 && !/no server running|No such file or directory/.test(result.stderr)) {
          throw new Error(`Failed to remove the isolated tmux server: ${result.stderr}`)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps fast exit panes and metadata, capturing both exit 0 and exit 42 output", async () => {
    const options = { cwd: dir, name: "fast build", sessionId: "ses_real", timeoutMs: 4_000 }
    const first = await manager.runBuild({ ...options, command: "printf 'hello-fast\\n'; exit 0" })
    expect(first).toMatchObject({
      ok: true, timedOut: false, tail: expect.stringContaining("hello-fast"), task: { status: "succeeded", exitCode: 0, shell: true },
    })
    const second = await manager.runBuild({ ...options, command: "printf 'failure-fast\\n'; exit 42" })
    expect(second).toMatchObject({
      ok: false, timedOut: false, tail: expect.stringContaining("failure-fast"), task: {
        paneId: first.task.paneId, id: first.task.id, exitCode: 42, status: "failed", restartCount: 1, shell: true,
      },
    })
    const mux = createMuxClient(backend, runner)
    expect(await mux.listPanes()).toContainEqual(expect.objectContaining({
      paneId: first.task.paneId, paneDead: false, taskId: first.task.id, managed: true,
      role: "build", sessionId: "ses_real", taskName: "fast build", cwd: dir,
      sessionName: projectMuxSession(dir), command: "printf 'failure-fast\\n'; exit 42",
    }))
    expect(await manager.captureLogs(first.task.id)).toContain("failure-fast")
  })

  it("retains pane options and remain-on-exit across direct respawn-pane -k", async () => {
    const mux = createMuxClient(backend, runner)
    const paneId = await mux.createManagedPane({
      id: "external-restart", role: "build", name: "external", cwd: dir, command: "exit 0", muxSession: projectMuxSession(dir),
    })
    await vi.waitFor(async () => {
      expect((await mux.listPanes()).find((pane) => pane.paneId === paneId)).toMatchObject({ paneDead: true, exitCode: 0 })
    })
    const [first] = await manager.listTasks({ name: "external" })
    await mux.respawnPane(paneId, { cwd: dir, command: "printf 'external restart\\n'; exit 42" })
    await vi.waitFor(async () => {
      expect((await manager.listTasks({ name: "external" }))[0]).toMatchObject({
        paneId, id: first.id, status: "failed", exitCode: 42, restartCount: 1,
      })
    })
    expect((await mux.listPanes()).find((pane) => pane.paneId === paneId)).toMatchObject({
      taskId: "external-restart", managed: true, taskName: "external", command: "exit 0",
    })
    const remain = await runner("tmux", ["-L", socketName, "show-options", "-p", "-v", "-t", paneId, "remain-on-exit"])
    expect(remain.stdout.trim()).toBe("on")
    expect(await mux.capturePane(paneId)).toBe("external restart")
    await mux.killPane(paneId)
    expect(await manager.listTasks({ name: "external" })).toMatchObject([{ status: "gone" }])
  })

  it("sends terminal C-c to a long-running service and preserves the stopped pane", async () => {
    const options = { cwd: dir, name: "interrupt-service" }
    const started = await manager.serviceAction({
      ...options, action: "start", command: "printf 'ready\\n'; exec sleep 30",
    })
    expect(started.task?.status).toBe("running")
    await vi.waitFor(async () => expect(await manager.captureLogs(started.task!.id)).toContain("ready"))
    const stopped = await manager.serviceAction({ ...options, action: "stop" })
    expect(stopped).toMatchObject({ ok: true, task: { status: "stopped", paneId: started.task!.paneId, shell: true } })
    expect(stopped.task?.exitCode).toBe(130)
    const marker = join(dir, "exit", `p${started.task!.paneId.slice(1)}_${started.task!.id}_${started.task!.panePid}.txt`)
    expect(await readFile(marker, "utf8")).toBe("130\n")
    await vi.waitFor(async () => expect(await manager.captureLogs(started.task!.id)).toContain("mux-test>"))
    const status = await manager.serviceAction({ ...options, action: "status" })
    expect(status.task?.status).toBe("stopped")
    await createMuxClient(backend, runner).killPane(started.task!.paneId)
    expect(await manager.listTasks({ name: options.name })).toMatchObject([{ status: "gone" }])
    await manager.pruneGone({ name: options.name })
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves literal input and command metadata containing tmux separators", async () => {
    const command = "printf 'ready\\n';\nIFS= read -r line; printf 'got:%s\\n' \"$line\";"
    const { task } = await manager.runBuild({ name: "literal input", cwd: dir, command, wait: false })
    await vi.waitFor(async () => expect(await manager.captureLogs(task.id)).toContain("ready"))
    await manager.sendInput(task.id, "C-c;", { enter: true })
    await vi.waitFor(async () => {
      expect((await manager.listTasks({ name: "literal input" }))[0]?.status).toBe("succeeded")
    })
    expect(await manager.captureLogs(task.id)).toContain("got:C-c;")
    const pane = (await createMuxClient(backend, runner).listPanes()).find((pane) => pane.taskId === task.id)
    expect(pane?.command).toBe(command)
  })

  it("unblocks wait-for promptly, preserving the pane exit code", async () => {
    const slowPoll = createMuxManager({ backend, runner, stateDir: dir, pollIntervalMs: 3_000 })
    const before = Date.now()
    const result = await slowPoll.runBuild({
      name: "wait channel", cwd: dir, command: "sleep 0.2; printf 'signalled\\n'; exit 42", timeoutMs: 5_000,
    })
    expect(Date.now() - before).toBeLessThan(2_500)
    expect(result).toMatchObject({
      ok: false, timedOut: false, tail: expect.stringContaining("signalled"), task: { status: "failed", exitCode: 42, shell: true },
    })
  })

  it("保留失败任务的交互 shell，接受未提交输入，并仅为 mux 会话设置 Byobu 键位", async () => {
    const { task } = await manager.runBuild({ cwd: dir, name: "failed shell", command: "false" })
    expect((await manager.listTasks({ name: task.name }))[0]).toMatchObject({ status: "failed", exitCode: 1, shell: true })
    const marker = join(dir, "exit", `p${task.paneId.slice(1)}_${task.id}_${task.panePid}.txt`)
    expect(await readFile(marker, "utf8")).toBe("1\n")
    await vi.waitFor(async () => expect(await manager.captureLogs(task.id)).toContain("mux-test>"))
    await manager.sendInput(task.id, "printf '%s\\n' pending-command", { enter: false })
    await vi.waitFor(async () => expect(await manager.captureLogs(task.id)).toContain("mux-test> printf '%s\\n' pending-command"))
    expect(await manager.captureLogs(task.id)).not.toMatch(/^pending-command$/m)

    const keys = await tmux("list-keys", "-T", "mux-byobu")
    expect(keys.stdout).toMatch(/F3\s+previous-window/)
    expect(keys.stdout).toMatch(/F4\s+next-window/)
    expect((await tmux("show-options", "-v", "-t", task.muxSession, "key-table")).stdout.trim()).toBe("mux-byobu")

    const restarted = await manager.restartTask(task.id, { command: "sleep 30" })
    expect(restarted.task).toMatchObject({ status: "running", paneId: task.paneId, restartCount: 1 })
    expect((await tmux("display-message", "-p", "-t", task.paneId, "#{pane_id}:#{pane_dead}")).stdout.trim()).toBe(`${task.paneId}:0`)
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("exit 清理非当前窗口，Ctrl+D 关闭最后一个窗口并允许 prune 清理哨兵", async () => {
    const cwd = join(dir, "shell-cleanup")
    await mkdir(cwd)
    const { task: first } = await manager.runBuild({ cwd, name: "exit", command: "false" })
    const { task: last } = await manager.runBuild({ cwd, name: "eof", command: "true" })
    const markers = [first, last].map((task) => join(dir, "exit", `p${task.paneId.slice(1)}_${task.id}_${task.panePid}.txt`))
    expect(await Promise.all(markers.map((marker) => readFile(marker, "utf8")))).toEqual(["1\n", "0\n"])
    for (const { id, paneId } of [first, last]) {
      const hooks = await tmux("show-hooks", "-p", "-t", paneId, "pane-died")
      expect(hooks.stdout).toMatch(/pane-died\[100\].*pane_dead.*kill-pane/)
      await vi.waitFor(async () => expect(await manager.captureLogs(id)).toContain("mux-test>"))
    }

    expect((await tmux("select-window", "-t", last.paneId)).exitCode).toBe(0)
    const windows = () => tmux("list-windows", "-t", first.muxSession, "-F", "#{pane_id}")
    expect((await windows()).stdout.trim().split("\n")).toEqual([first.paneId, last.paneId])
    expect((await tmux("send-keys", "-t", first.paneId, "exit", "Enter")).exitCode).toBe(0)
    await vi.waitFor(async () => {
      expect((await windows()).stdout.trim()).toBe(last.paneId)
      expect(await manager.listTasks({ cwd, name: first.name })).toMatchObject([{ id: first.id, status: "gone" }])
    })
    await expect(manager.sendInput(first.id, "anything")).rejects.toThrow("no live pane")

    expect((await tmux("send-keys", "-t", last.paneId, "C-d")).exitCode).toBe(0)
    await vi.waitFor(async () => {
      const session = await tmux("has-session", "-t", `=${first.muxSession}`)
      expect(session.exitCode).toBe(1)
      expect(session.stderr).toContain("can't find session")
    })
    expect(await manager.listTasks({ cwd, status: "gone" })).toHaveLength(2)
    expect(await manager.pruneGone({ cwd })).toHaveLength(2)
    expect(await manager.listTasks({ cwd })).toEqual([])
    for (const marker of markers) await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("mux_restart 为 hook 已清理的任务新建窗口，保留任务 ID", async () => {
    const cwd = join(dir, "restart-cleanup")
    await mkdir(cwd)
    const { task: old } = await manager.runBuild({ cwd, name: "rebuild", command: "false" })
    const { task: sibling } = await manager.runBuild({ cwd, name: "sibling", command: "sleep 30", wait: false })
    await vi.waitFor(async () => expect(await manager.captureLogs(old.id)).toContain("mux-test>"))
    expect((await tmux("send-keys", "-t", old.paneId, "exit", "Enter")).exitCode).toBe(0)
    await vi.waitFor(async () => expect(await manager.listTasks({ cwd, name: old.name })).toMatchObject([{ status: "gone" }]))

    const restarted = await manager.restartTask(old.id, { command: "sleep 30" })
    expect(restarted).toMatchObject({ ok: true, task: { id: old.id, muxSession: old.muxSession, status: "running", restartCount: 1 } })
    expect(restarted.task!.paneId).not.toBe(old.paneId)
    const windows = await tmux("list-windows", "-t", old.muxSession, "-F", "#{pane_id}")
    expect(new Set(windows.stdout.trim().split("\n"))).toEqual(new Set([sibling.paneId, restarted.task!.paneId]))
    const marker = join(dir, "exit", `p${old.paneId.slice(1)}_${old.id}_${old.panePid}.txt`)
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("启用 hook 时仍可强制停止并移除任务，重复 kill-pane 不报错", async () => {
    const cwd = join(dir, "force-stop-cleanup")
    await mkdir(cwd)
    const started = await manager.serviceAction({
      cwd, name: "force-stop", action: "start", command: "trap '' INT; printf 'ready\\n'; exec sleep 30",
    })
    const { id, paneId } = started.task!
    await vi.waitFor(async () => expect(await manager.captureLogs(id)).toContain("ready"))
    expect(await manager.stopTask(id, { timeoutMs: 0, force: true })).toMatchObject({ ok: true, task: { status: "stopped", forceStopped: true } })
    const mux = createMuxClient(backend, runner)
    expect((await mux.listPanes()).some((pane) => pane.paneId === paneId)).toBe(false)
    await expect(mux.killPane(paneId)).resolves.toBeUndefined()
    expect(await manager.removeTask(id)).toMatchObject({ ok: true })
    expect(await manager.listTasks({ cwd })).toEqual([])
  })

  it("关闭两项功能时，保留原有的 dead pane 和默认键表", async () => {
    const cwd = join(dir, "legacy")
    await mkdir(cwd)
    const legacy = createMuxManager({ backend, runner, stateDir: dir, keepShellOnExit: false, byobuKeys: false })
    const { task } = await legacy.runBuild({ cwd, name: "legacy", command: "false" })
    expect(task).toMatchObject({ status: "failed", exitCode: 1 })
    expect(task.shell).toBeUndefined()
    const pane = (await createMuxClient(backend, runner).listPanes()).find((pane) => pane.paneId === task.paneId)
    expect(pane).toMatchObject({ paneDead: true, exitCode: 1 })
    expect((await tmux("show-hooks", "-p", "-t", task.paneId, "pane-died")).stdout.trim()).toBe("")
    const keys = await runner("tmux", ["-L", socketName, "show-options", "-Av", "-t", task.muxSession, "key-table"])
    expect(keys.stdout.trim()).toBe("root")
  })

  it("按精确名称关闭项目会话，不关闭名称相近的会话", async () => {
    const cwd = join(dir, "close")
    await mkdir(cwd)
    const { task } = await manager.runBuild({ cwd, name: "close", command: "false" })
    const neighbor = `${task.muxSession}-neighbor`
    expect((await tmux("new-session", "-d", "-s", neighbor)).exitCode).toBe(0)
    expect(await manager.closeSession({ cwd })).toEqual({ ok: true, removed: 1, sessionName: task.muxSession })
    expect(await manager.closeSession({ cwd })).toEqual({ ok: true, removed: 0, sessionName: task.muxSession })
    const sessions = (await tmux("list-sessions", "-F", "#{session_name}")).stdout.trim().split("\n")
    expect(sessions).toContain(neighbor)
    expect(sessions).not.toContain(task.muxSession)
  })

  it("默认主题覆盖首窗、受管新窗和模拟 F2 新窗，并原样移植 root 鼠标绑定", async () => {
    const cwd = join(dir, "theme-powerline")
    await mkdir(cwd)
    const { task } = await manager.runBuild({ cwd, name: "theme", command: "sleep 30", wait: false })
    const { task: managed } = await manager.runBuild({ cwd, name: "managed theme", command: "sleep 30", wait: false })
    const session = task.muxSession
    const sessionOptions = {
      status: "on", "status-position": "bottom", "status-interval": "1", "status-justify": "left",
      "status-style": "bg=#333333,fg=#eeeeee", "status-left-style": "default", "status-left-length": "16",
      "status-left": "#[bg=#5faf5f,fg=#1c1c1c,bold] mux #[bg=#333333,fg=#5faf5f,nobold]#[default] ",
      "status-right-style": "default", "status-right-length": "96",
      "status-right": "#[bg=#333333,fg=#4e4e4e]#[bg=#4e4e4e,fg=#eeeeee] #S #[bg=#4e4e4e,fg=#1c1c1c]#[bg=#1c1c1c,fg=#b8b8b8] %Y-%m-%d #[fg=#eeeeee,bold]%H:%M:%S #[default]",
      mouse: "on", "renumber-windows": "on", "visual-activity": "off",
      "message-style": "bg=#75507b,fg=#eeeeee,bold", "message-command-style": "bg=#333333,fg=#87d75f,bold",
    }
    await Promise.all(Object.entries(sessionOptions).map(async ([key, value]) => {
      expect((await tmux("show-options", "-v", "-t", session, key)).stdout).toBe(`${value}\n`)
    }))
    expect((await tmux("show-hooks", "-t", session, "after-new-window")).stdout).toMatch(/after-new-window\[100\].*window-status-current-format/)
    expect((await tmux("show-hooks", "-p", "-t", task.paneId, "pane-died")).stdout).toContain("pane-died[100]")

    const f2 = await tmux("list-keys", "-T", "mux-byobu", "F2")
    expect(f2.stdout).toMatch(/F2\s+new-window -c "#\{pane_current_path\}"/)
    // 模拟 F2 的 new-window 命令，不通过 manager，验证新窗只靠 hook 就能套用主题。
    const manual = await tmux("new-window", "-d", "-t", `${session}:`, "-c", "#{pane_current_path}", "-P", "-F", "#{pane_id}", "sleep 30")
    expect(manual.exitCode).toBe(0)
    for (const pane of [task.paneId, managed.paneId, manual.stdout.trim()]) {
      expect((await tmux("show-options", "-wv", "-t", pane, "window-status-format")).stdout).toBe(" #I  #W#{?window_flags,#{window_flags},} \n")
      expect((await tmux("show-options", "-wv", "-t", pane, "pane-active-border-style")).stdout.trim()).toBe("fg=#5faf5f")
      expect((await tmux("show-options", "-wv", "-t", pane, "monitor-activity")).stdout.trim()).toBe("on")
      expect((await tmux("show-options", "-wv", "-t", pane, "automatic-rename")).stdout).toBe("")
    }
    const listMouse = async (table: string) => (await tmux("list-keys", "-T", table)).stdout.split("\n")
      .flatMap((line) => line.match(new RegExp(`-T ${table}\\s+((?:[CMS]-)*(?:Mouse|Wheel|DoubleClick|TripleClick)\\S*)\\s+(.*)`))?.slice(1).join(" ") ?? [])
    const rootMouse = await listMouse("root")
    expect(rootMouse).toEqual(expect.arrayContaining([expect.stringMatching(/^MouseDown1Status /), expect.stringMatching(/^DoubleClick1Pane /)]))
    expect(await listMouse("mux-byobu")).toEqual(rootMouse)
    expect((await tmux("show-options", "-gv", "mouse")).stdout.trim()).toBe("off")
  })

  it("ascii 使用纯文本标签并传给后续窗口，off 不写外观选项或主题 hook", async () => {
    for (const statusTheme of ["ascii", "off"] as const) {
      const cwd = join(dir, `theme-${statusTheme}`)
      await mkdir(cwd)
      const variant = createMuxManager({ backend, runner, stateDir: dir, statusTheme })
      const { task } = await variant.runBuild({ cwd, name: statusTheme, command: "sleep 30", wait: false })
      const { muxSession } = task
      const right = await tmux("show-options", "-v", "-t", muxSession, "status-right")
      const hooks = await tmux("show-hooks", "-t", muxSession, "after-new-window")
      if (statusTheme === "off") {
        expect(right.stdout).toBe("")
        expect(hooks.stdout).not.toContain("after-new-window[100]")
        expect((await tmux("show-options", "-wv", "-t", task.paneId, "window-status-current-format")).stdout).toBe("")
        expect((await tmux("show-options", "-v", "-t", muxSession, "mouse")).stdout).toBe("")
      } else {
        expect(right.stdout).toBe("#S + %Y-%m-%d + %H:%M:%S\n")
        expect(hooks.stdout).toContain("after-new-window[100]")
        const manual = await tmux("new-window", "-d", "-t", `${muxSession}:`, "-P", "-F", "#{pane_id}", "sleep 30")
        expect(manual.exitCode).toBe(0)
        for (const pane of [task.paneId, manual.stdout.trim()]) {
          expect((await tmux("show-options", "-wv", "-t", pane, "window-status-current-format")).stdout).toBe(" #I:#W#{?window_flags,#{window_flags},} \n")
        }
      }
    }
  })

  it("解析 root 键表失败时绑定核心鼠标操作", async () => {
    const cwd = join(dir, "theme-mouse-fallback")
    await mkdir(cwd)
    const failingList: CommandRunner = (file, args, options) => {
      if (args[2] === "list-keys") return Promise.resolve({ exitCode: 0, stdout: "不可解析", stderr: "" })
      return runner(file, args, options)
    }
    const fallback = createMuxManager({ backend, runner: failingList, stateDir: dir })
    await fallback.runBuild({ cwd, name: "fallback", command: "sleep 30", wait: false })
    const keys = await tmux("list-keys", "-T", "mux-byobu")
    expect(keys.exitCode).toBe(0)
    for (const key of ["MouseDown1Status", "WheelUpStatus", "WheelDownStatus", "MouseDown1Pane",
      "WheelUpPane", "WheelDownPane", "MouseDrag1Pane", "MouseDrag1Border"]) {
      expect(keys.stdout).toMatch(new RegExp(`\\b${key}\\s`))
    }
  })
})
