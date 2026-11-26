import { resolve } from "node:path"
import type { ManagedTask } from "@misakacloud/opencode-mux-core"
import { describe, expect, it, vi } from "vitest"
import { createMuxTools } from "../index"

const project = resolve("test-project")
const other = resolve("other-project")
const session = { sessionID: "ses_test" }
const origin = { source: "ai", sessionId: "ses_test" }
const cmd = "tmux attach-session -t session"

function task(overrides: Partial<ManagedTask> = {}): ManagedTask {
  return {
    id: "build-1", name: "app", role: "build", cwd: project, command: "bun run build",
    status: "running", muxKind: "tmux", muxSession: "session", paneId: "%1",
    restartCount: 0, createdAt: "", updatedAt: "", ...overrides,
  }
}

function harness(defaults?: Parameters<typeof createMuxTools>[2]) {
  type Manager = Parameters<typeof createMuxTools>[0]
  const manager = {
    runBuild: vi.fn<Manager["runBuild"]>(),
    serviceAction: vi.fn<Manager["serviceAction"]>(),
    restartTask: vi.fn<Manager["restartTask"]>(),
    removeTask: vi.fn<Manager["removeTask"]>(),
    closeSession: vi.fn<Manager["closeSession"]>(),
    captureLogs: vi.fn<Manager["captureLogs"]>().mockResolvedValue("line 1\nline 2"),
    sendInput: vi.fn<Manager["sendInput"]>().mockResolvedValue(undefined),
    listTasks: vi.fn<Manager["listTasks"]>().mockResolvedValue([task()]),
    listPanes: vi.fn<Manager["listPanes"]>().mockResolvedValue([]),
    adoptPane: vi.fn<Manager["adoptPane"]>().mockResolvedValue(task()),
    pruneGone: vi.fn<Manager["pruneGone"]>().mockResolvedValue([]),
    previewHistory: vi.fn<Manager["previewHistory"]>().mockResolvedValue([]),
    cleanHistory: vi.fn<Manager["cleanHistory"]>().mockResolvedValue({ removed: [], skipped: [], failed: [] }),
    attachCommand: vi.fn<Manager["attachCommand"]>().mockResolvedValue(cmd),
  }
  const tools = createMuxTools(manager, project, defaults)
  const call = (name: string, input?: unknown, context?: typeof session) =>
    tools.find((tool) => tool.name === name)!.execute(input, context)
  return { manager, call }
}

describe("mux_run_build", () => {
  it.each([
    ["succeeded", 0, true, false],
    ["failed", 42, false, false],
    ["running", undefined, false, true],
    ["gone", undefined, false, false],
  ] as const)("返回 %s 及退出信息，不用异常表示构建失败或超时", async (status, exitCode, ok, timedOut) => {
    const { manager, call } = harness({ defaultTimeoutMs: 100, defaultTailLines: 8 })
    const built = task({ status, exitCode })
    manager.runBuild.mockResolvedValue({ task: built, ok, timedOut, tail: "build output" })

    const result = await call("mux_run_build", { name: "app", command: "bun run build", cwd: "sub" }, session)
    expect(manager.runBuild).toHaveBeenCalledWith({
      name: "app", command: "bun run build", cwd: resolve(project, "sub"),
      ...origin, timeoutMs: 100, tailLines: 8,
    })
    expect(manager.attachCommand).toHaveBeenCalledWith(built)
    expect(result.metadata).toMatchObject({
      id: built.id, muxSession: built.muxSession, paneId: built.paneId, attachCommand: cmd,
      status, exitCode: exitCode ?? null, ok, timedOut, tail: "build output",
    })
    expect(result.content[0].text).toContain("build output")
    if (timedOut) expect(result.content[0].text).toContain("pane 不会被终止")
  })

  it("传递 wait=false，且显式的零覆盖默认值", async () => {
    const { manager, call } = harness({ defaultTimeoutMs: 100, defaultTailLines: 8 })
    manager.runBuild.mockResolvedValue({ task: task(), ok: true, timedOut: false, tail: "" })
    const result = await call("mux_run_build", { name: "app", command: "build", wait: false, timeoutMs: 0, tailLines: 0 })
    expect(manager.runBuild).toHaveBeenCalledWith({
      name: "app", command: "build", cwd: project, wait: false, source: "ai", sessionId: undefined,
      timeoutMs: 0, tailLines: 0,
    })
    expect(result.metadata).toMatchObject({ status: "running", ok: true })
  })
})

describe("mux_service", () => {
  it("处理 start、status、restart、stop 和 remove，报告状态及日志", async () => {
    const { manager, call } = harness()
    const running = task({ id: "service-1", role: "service" })
    const restarted = { ...running, restartCount: 1 }
    const stopped = task({ ...restarted, status: "stopped" })
    manager.serviceAction
      .mockResolvedValueOnce({ ok: true, task: running })
      .mockResolvedValueOnce({ ok: true, task: running })
      .mockResolvedValueOnce({ ok: true, task: restarted })
      .mockResolvedValueOnce({ ok: true, task: stopped })
      .mockResolvedValueOnce({ ok: true, task: stopped })

    const act = (action: string, extra = {}) => call("mux_service", { name: "app", action, ...extra }, session)
    expect((await act("start", { command: "serve", restartIfRunning: true })).metadata).toMatchObject({
      ok: true, status: "running", restartCount: 0, attachCommand: cmd, tail: "line 1\nline 2",
    })
    expect(manager.serviceAction).toHaveBeenLastCalledWith({
      name: "app", action: "start", command: "serve", restartIfRunning: true, cwd: project, timeoutMs: undefined, ...origin,
    })
    expect((await act("status")).metadata.status).toBe("running")
    expect((await act("restart", { tailLines: 3 })).metadata.restartCount).toBe(1)
    expect((await act("stop", { force: true, timeoutMs: 7 })).metadata.status).toBe("stopped")
    expect(manager.serviceAction).toHaveBeenLastCalledWith({
      name: "app", action: "stop", cwd: project, force: true, timeoutMs: 7, ...origin,
    })
    expect((await act("remove")).metadata).toMatchObject({ status: "removed", tail: "" })
    expect(manager.captureLogs.mock.calls).toEqual([
      [running.id, 30], [running.id, 30], [running.id, 3], [running.id, 30],
    ])
  })

  it("报告停止超时，即使 pane 在抓取日志前消失", async () => {
    const { manager, call } = harness({ defaultTimeoutMs: 23, defaultTailLines: 10 })
    const running = task({ role: "service" })
    manager.serviceAction.mockResolvedValue({ ok: false, task: running, timedOut: true })
    manager.captureLogs.mockRejectedValue(new Error("pane vanished"))
    const result = await call("mux_service", { name: "app", action: "stop", cwd: "server" })
    expect(manager.serviceAction).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 23, cwd: resolve(project, "server") }))
    expect(manager.captureLogs).toHaveBeenCalledWith(running.id, 10)
    expect(result.metadata).toMatchObject({ ok: false, timedOut: true, status: "running", tail: "", tailError: "pane vanished" })
    expect(result.content[0].text).toContain("等待停止超时")
  })

  it.each([
    [undefined, undefined, "not_found"],
    [task({ status: "gone" }), undefined, "gone"],
    [task({ status: "stopped", forceStopped: true }), undefined, "stopped"],
    [task(), 0, "running"],
  ] as const)("不抓取不存在的 pane 或禁用日志的结果（%#）", async (item, tailLines, status) => {
    const { manager, call } = harness()
    manager.serviceAction.mockResolvedValue({ ok: Boolean(item), task: item })
    const result = await call("mux_service", { name: "app", action: "status", tailLines })
    expect(manager.captureLogs).not.toHaveBeenCalled()
    expect(result.metadata).toMatchObject({ status, tail: "" })
  })
})

describe("任务选择、重启、日志和输入", () => {
  it.each(["mux_restart", "mux_logs", "mux_input"])("%s 提示同名任务的候选项且不执行操作", async (name) => {
    const { manager, call } = harness()
    const otherTask = task({ id: "service-2", role: "service", cwd: other })
    manager.listTasks.mockResolvedValue([task(), otherTask])
    const result = await call(name, { name: "app", input: "reload" })
    expect(result.metadata).toMatchObject({
      ok: false, error: "ambiguous_task", candidates: [
        { id: "build-1", cwd: project, role: "build" }, { id: "service-2", cwd: other, role: "service" },
      ],
    })
    expect(result.content[0].text).toContain("id=service-2")
    expect(manager.restartTask).not.toHaveBeenCalled()
    expect(manager.captureLogs).not.toHaveBeenCalled()
    expect(manager.sendInput).not.toHaveBeenCalled()
  })

  it("提示缺少选择条件和找不到任务", async () => {
    const { manager, call } = harness()
    expect((await call("mux_restart", {})).metadata.error).toBe("missing_selector")
    expect(manager.listTasks).not.toHaveBeenCalled()
    expect((await call("mux_logs", { id: "missing" })).metadata.error).toBe("task_not_found")
  })

  it("按名称、角色及相对目录解析重启目标，回传新 pane 日志", async () => {
    const { manager, call } = harness()
    const restarted = task({ restartCount: 1, paneId: "%2" })
    manager.restartTask.mockResolvedValue({ ok: true, task: restarted })
    const result = await call("mux_restart", { name: "app", role: "build", cwd: ".", command: "build --retry", tailLines: 5 }, session)
    expect(manager.listTasks).toHaveBeenCalledWith({ name: "app", role: "build", cwd: project })
    expect(manager.restartTask).toHaveBeenCalledWith(restarted.id, { command: "build --retry", mode: undefined, ...origin })
    expect(manager.captureLogs).toHaveBeenCalledWith(restarted.id, 5)
    expect(result.metadata).toMatchObject({ restartCount: 1, paneId: "%2", tail: "line 1\nline 2" })
  })

  it("ID 优先于名称、目录和角色；日志默认 100 行并包含失败退出码", async () => {
    const { manager, call } = harness({ defaultTailLines: 9 })
    manager.listTasks.mockResolvedValue([task({ status: "failed", exitCode: 1 })])
    const result = await call("mux_logs", { id: "build-1", name: "ignored", cwd: other, role: "service" })
    expect(manager.listTasks).toHaveBeenCalledWith()
    expect(manager.captureLogs).toHaveBeenCalledWith("build-1", 100)
    expect(result.metadata).toMatchObject({ status: "failed", exitCode: 1, attachCommand: cmd, logs: "line 1\nline 2" })
    expect(result.content[0].text).toContain("line 2")
    await call("mux_logs", { id: "build-1", lines: 0 })
    expect(manager.captureLogs).toHaveBeenLastCalledWith("build-1", 0)
  })

  it("按 ID 发送文本，默认回车且保留 enter=false", async () => {
    const { manager, call } = harness()
    const result = await call("mux_input", { id: "build-1", input: "" })
    expect(manager.sendInput).toHaveBeenCalledWith("build-1", "", { enter: true })
    expect(result.metadata).toMatchObject({ ok: true, id: "build-1", enter: true })
    await call("mux_input", { id: "build-1", input: "reload", enter: false })
    expect(manager.sendInput).toHaveBeenLastCalledWith("build-1", "reload", { enter: false })
  })
})

describe("mux_remove", () => {
  it("按 ID 移除 pane 已丢失的构建任务", async () => {
    const { manager, call } = harness()
    const build = task({ status: "gone" })
    manager.listTasks.mockResolvedValue([build])
    manager.removeTask.mockResolvedValue({ ok: true, task: build })
    expect((await call("mux_remove", { id: build.id })).metadata).toMatchObject({
      ok: true, id: build.id, role: "build", status: "removed",
    })
    expect(manager.removeTask).toHaveBeenCalledWith(build.id)
    expect(manager.closeSession).not.toHaveBeenCalled()
  })

  it.each([undefined, "child"])("关闭指定项目会话，不需要任务选择器：%s", async (cwd) => {
    const { manager, call } = harness()
    const response = { ok: true, removed: 2, sessionName: "oc-project-a" } as const
    manager.closeSession.mockResolvedValue(response)
    expect((await call("mux_remove", { session: true, cwd })).metadata).toEqual(response)
    expect(manager.closeSession).toHaveBeenCalledWith({ cwd: resolve(project, cwd ?? ".") })
    expect(manager.listTasks).not.toHaveBeenCalled()
    expect(manager.removeTask).not.toHaveBeenCalled()
  })
})

describe("mux_list", () => {
  it("默认限定项目，all 查看全部，显式 cwd 仍可作为过滤条件", async () => {
    const { manager, call } = harness()
    const result = await call("mux_list")
    expect(manager.listTasks).toHaveBeenLastCalledWith({ cwd: project, role: undefined, status: undefined })
    expect(manager.pruneGone).not.toHaveBeenCalled()
    expect(result.metadata).toMatchObject({ total: 1, tasks: [{ id: "build-1", attachCommand: cmd }] })
    await call("mux_list", { all: true })
    expect(manager.listTasks).toHaveBeenLastCalledWith({ cwd: undefined, role: undefined, status: undefined })
    await call("mux_list", { all: true, cwd: "child" })
    expect(manager.listTasks).toHaveBeenLastCalledWith({ cwd: resolve(project, "child"), role: undefined, status: undefined })
  })

  it("先按目录和角色清理，再按状态过滤，并附加所有任务的命令", async () => {
    const { manager, call } = harness()
    manager.pruneGone.mockResolvedValue([task({ id: "lost", role: "service", status: "gone" })])
    manager.listTasks.mockResolvedValue([task({ id: "s1", role: "service" }), task({ id: "s2", role: "service" })])
    const result = await call("mux_list", { pruneGone: true, role: "service", status: "running" })
    expect(manager.pruneGone).toHaveBeenCalledWith({ cwd: project, role: "service" })
    expect(manager.listTasks).toHaveBeenCalledWith({ cwd: project, role: "service", status: "running" })
    expect(manager.pruneGone.mock.invocationCallOrder[0]).toBeLessThan(manager.listTasks.mock.invocationCallOrder[0])
    expect(manager.attachCommand).toHaveBeenCalledTimes(2)
    expect(result.metadata).toMatchObject({ total: 2, tasks: [{ attachCommand: cmd }, { attachCommand: cmd }], pruned: [{ id: "lost" }] })
  })
})

describe("mux_clean_history", () => {
  it("默认只预览当前项目，返回可原样提交的候选标识", async () => {
    const { manager, call } = harness()
    const candidate = { id: "build-1", updatedAt: "2026-01-01T00:00:00.000Z", restartCount: 2 }
    manager.previewHistory.mockResolvedValue([task({ ...candidate, status: "succeeded", shell: true })])
    const result = await call("mux_clean_history")
    expect(manager.previewHistory).toHaveBeenCalledWith({ cwd: project })
    expect(manager.cleanHistory).not.toHaveBeenCalled()
    expect(manager.pruneGone).not.toHaveBeenCalled()
    expect(result.metadata).toMatchObject({
      ok: true, cwd: project, candidates: [candidate], tasks: [{ ...candidate, status: "succeeded", shell: true }],
    })
    expect(result.content[0].text).toContain("未执行清理")
    expect(result.content[0].text).toContain("含驻留 shell")
  })

  it("显式提交候选项和范围，报告部分成功且不重新预览", async () => {
    const { manager, call } = harness()
    const candidates = [{ id: "build-1", updatedAt: "2026-01-01T00:00:00.000Z", restartCount: 0 }]
    const outcome = { removed: ["build-1"], skipped: ["stale"], failed: [{ id: "blocked", message: "permission denied" }] }
    manager.cleanHistory.mockResolvedValueOnce(outcome)
    const result = await call("mux_clean_history", { cwd: "sub", includeShell: true, retentionDays: 0, candidates })
    expect(manager.cleanHistory).toHaveBeenCalledWith({ cwd: resolve(project, "sub"), includeShell: true, retentionDays: 0, candidates })
    expect(manager.previewHistory).not.toHaveBeenCalled()
    expect(manager.closeSession).not.toHaveBeenCalled()
    expect(result.metadata).toEqual({ ok: false, cwd: resolve(project, "sub"), ...outcome })
    expect(result.content[0].text).toContain("permission denied")
  })
})

describe("mux_panes / mux_adopt", () => {
  const pane = (overrides: Record<string, unknown> = {}) => ({
    paneId: "%12", sessionName: "oc-project", windowIndex: 0,
    cwd: project, paneCurrentPath: project, paneCurrentCommand: "zsh",
    foregroundCommand: "npm run dev", managed: false, ...overrides,
  })

  it("mux_panes 列出所有窗格，显示实际命令，默认限定当前项目的 oc- 会话", async () => {
    const { manager, call } = harness()
    manager.listPanes.mockResolvedValue([pane(), pane({ paneId: "%13", managed: true, taskId: "t1" })] as never)
    const result = await call("mux_panes")
    expect(manager.listPanes).toHaveBeenCalledWith({ cwd: project, all: undefined })
    expect(result.metadata).toMatchObject({ ok: true, panes: expect.any(Array) })
    expect(result.content[0].text).toContain("npm run dev")
    expect(result.content[0].text).toContain("手动")
    expect(result.content[0].text).toContain("受管 task=t1")
  })

  it("mux_panes 的 all 跨项目", async () => {
    const { manager, call } = harness()
    await call("mux_panes", { all: true })
    expect(manager.listPanes).toHaveBeenCalledWith({ cwd: undefined, all: true })
  })

  it("mux_adopt 收编手动窗格为受管任务并返回附加命令", async () => {
    const { manager, call } = harness()
    const adopted = task({ id: "adopted-1", name: "my-dev", command: "npm run dev" })
    manager.adoptPane.mockResolvedValue(adopted)
    const result = await call("mux_adopt", { paneId: "%12", name: "my-dev", cwd: "sub" }, session)
    expect(manager.adoptPane).toHaveBeenCalledWith({ paneId: "%12", name: "my-dev", cwd: resolve(project, "sub") })
    expect(manager.attachCommand).toHaveBeenCalledWith(adopted)
    expect(result.metadata).toMatchObject({ ok: true, id: "adopted-1", attachCommand: cmd })
  })

  it("mux_restart 的 mode=input 透传给管理器，原地重启不建新窗格", async () => {
    const { manager, call } = harness()
    const restarted = task({ paneId: "%1" })
    manager.restartTask.mockResolvedValue({ ok: true, task: restarted })
    const result = await call("mux_restart", { id: "build-1", mode: "input", command: "bun run build" }, session)
    expect(manager.restartTask).toHaveBeenCalledWith("build-1", { command: "bun run build", mode: "input", ...origin })
    expect(result.metadata).toMatchObject({ ok: true, paneId: "%1" })
  })
})
