import type { ManagedTask } from "@misakacloud/opencode-mux-core"
import { describe, expect, it, vi } from "vitest"
import type { HistoryCleanResponse, HistoryPreviewResponse } from "../src/types"
import { HistoryCleanPartialError, ServiceApiError, type MuxClient } from "../src/ui/client"
import { createHistoryDialogController } from "../src/ui/history"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeTask(overrides: Partial<ManagedTask> = {}): ManagedTask {
  return {
    id: "task-1",
    role: "build",
    name: "typecheck",
    cwd: "/projects/alpha",
    command: "bun run typecheck",
    muxKind: "tmux",
    muxSession: "oc-alpha",
    paneId: "%1",
    status: "gone",
    restartCount: 0,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  }
}

function setupController(initialDir: string | null = "/projects/alpha") {
  let currentDir = initialDir
  const previewHistory = vi.fn<MuxClient["previewHistory"]>()
  const cleanHistory = vi.fn<MuxClient["cleanHistory"]>()
  const onChange = vi.fn()
  const onRemoved = vi.fn()
  const onNotify = vi.fn()
  const onRefresh = vi.fn()

  const controller = createHistoryDialogController({
    client: { previewHistory, cleanHistory },
    getCurrentDirectory: () => currentDir,
    onChange,
    onRemoved,
    onNotify,
    onRefresh,
  })

  return {
    controller,
    previewHistory,
    cleanHistory,
    onChange,
    onRemoved,
    onNotify,
    onRefresh,
    setDirectory(next: string | null) {
      currentDir = next
      controller.onDirectoryChange(next)
    },
  }
}

describe("历史清理弹窗状态控制", () => {
  it("无当前项目目录时禁止打开，防止全局清理", () => {
    const ctx = setupController(null)
    expect(ctx.controller.open()).toBe(false)
    expect(ctx.controller.getState()).toBeNull()
    expect(ctx.previewHistory).not.toHaveBeenCalled()

    ctx.setDirectory("   ")
    expect(ctx.controller.open()).toBe(false)
    expect(ctx.previewHistory).not.toHaveBeenCalled()
  })

  it("切换勾选驻留 shell 时重取预览、立即清空旧候选并屏蔽过期响应", async () => {
    const firstPreview = deferred<HistoryPreviewResponse>()
    const secondPreview = deferred<HistoryPreviewResponse>()
    const thirdPreview = deferred<HistoryPreviewResponse>()
    const ctx = setupController("/projects/alpha")

    ctx.previewHistory
      .mockReturnValueOnce(firstPreview.promise)
      .mockReturnValueOnce(secondPreview.promise)
      .mockReturnValueOnce(thirdPreview.promise)

    expect(ctx.controller.open()).toBe(true)
    expect(ctx.previewHistory).toHaveBeenLastCalledWith({ cwd: "/projects/alpha", includeShell: false })
    expect(ctx.controller.getState()?.previewLoading).toBe(true)

    const oldTask = makeTask({ id: "gone-1", name: "old-gone" })
    firstPreview.resolve({ tasks: [oldTask] })
    await firstPreview.promise
    expect(ctx.controller.getState()?.previewTasks.map((t) => t.id)).toEqual(["gone-1"])

    // 勾选包含驻留 shell 后立刻清空旧候选，随后在未返回时再次取消勾选。
    ctx.controller.setIncludeShell(true)
    expect(ctx.controller.getState()?.previewLoading).toBe(true)
    expect(ctx.controller.getState()?.previewTasks).toEqual([])
    ctx.controller.setIncludeShell(false)

    expect(ctx.previewHistory).toHaveBeenNthCalledWith(2, { cwd: "/projects/alpha", includeShell: true })
    expect(ctx.previewHistory).toHaveBeenNthCalledWith(3, { cwd: "/projects/alpha", includeShell: false })

    // 确认按钮在加载期间不会提交任何旧候选。
    await ctx.controller.confirm()
    expect(ctx.cleanHistory).not.toHaveBeenCalled()

    const staleShellTask = makeTask({ id: "shell-1", status: "failed", shell: true })
    secondPreview.resolve({ tasks: [staleShellTask] })
    await secondPreview.promise
    // 第二次（过期）请求被屏蔽，不覆盖状态。
    expect(ctx.controller.getState()?.previewLoading).toBe(true)
    expect(ctx.controller.getState()?.previewTasks).toEqual([])

    const latestTask = makeTask({ id: "gone-2", name: "latest-gone", restartCount: 2 })
    thirdPreview.resolve({ tasks: [latestTask] })
    await thirdPreview.promise
    expect(ctx.controller.getState()?.previewLoading).toBe(false)
    expect(ctx.controller.getState()?.includeShell).toBe(false)
    expect(ctx.controller.getState()?.previewTasks.map((t) => t.id)).toEqual(["gone-2"])
  })

  it("确认提交严格绑定预览快照且只传 {id, updatedAt, restartCount}", async () => {
    const ctx = setupController("/projects/alpha")
    const t1 = makeTask({ id: "t1", updatedAt: "2026-11-01T00:00:00Z", restartCount: 1 })
    const t2 = makeTask({ id: "t2", status: "succeeded", updatedAt: "2026-11-02T00:00:00Z", restartCount: 0, shell: true })

    ctx.previewHistory.mockResolvedValueOnce({ tasks: [t1] })
    ctx.controller.open()
    await vi.waitFor(() => expect(ctx.controller.getState()?.previewLoading).toBe(false))

    ctx.previewHistory.mockResolvedValueOnce({ tasks: [t1, t2] })
    ctx.controller.setIncludeShell(true)
    await vi.waitFor(() => expect(ctx.controller.getState()?.previewLoading).toBe(false))

    ctx.cleanHistory.mockResolvedValueOnce({ removed: ["t1", "t2"], skipped: [], failed: [] })
    await ctx.controller.confirm()

    expect(ctx.cleanHistory).toHaveBeenCalledWith({
      cwd: "/projects/alpha",
      includeShell: true,
      candidates: [
        { id: "t2", updatedAt: "2026-11-02T00:00:00Z", restartCount: 0 },
        { id: "t1", updatedAt: "2026-11-01T00:00:00Z", restartCount: 1 },
      ],
    })
    expect(ctx.onRemoved).toHaveBeenCalledWith(["t1", "t2"])
    expect(ctx.controller.getState()).toBeNull()
    expect(ctx.onNotify).toHaveBeenCalledWith("success", "已清理 2 条历史记录")
    expect(ctx.onRefresh).toHaveBeenCalledOnce()
  })

  it("切换项目时关闭未确认弹窗并丢弃旧项目预览响应", async () => {
    const alphaPreview = deferred<HistoryPreviewResponse>()
    const ctx = setupController("/projects/alpha")
    ctx.previewHistory.mockReturnValueOnce(alphaPreview.promise)

    ctx.controller.open()
    expect(ctx.controller.getState()?.targetCwd).toBe("/projects/alpha")

    ctx.setDirectory("/projects/beta")
    expect(ctx.controller.getState()).toBeNull()

    alphaPreview.resolve({ tasks: [makeTask({ cwd: "/projects/alpha" })] })
    await alphaPreview.promise
    expect(ctx.controller.getState()).toBeNull()
    expect(ctx.cleanHistory).not.toHaveBeenCalled()
  })

  it("部分跳过或失败时保留弹窗展示结果且禁止重复提交同批候选", async () => {
    const ctx = setupController("/projects/alpha")
    const t1 = makeTask({ id: "t1", name: "done" })
    const t2 = makeTask({ id: "t2", name: "changed" })
    const t3 = makeTask({ id: "t3", name: "blocked" })
    ctx.previewHistory.mockResolvedValueOnce({ tasks: [t1, t2, t3] })
    ctx.controller.open()
    await vi.waitFor(() => expect(ctx.controller.getState()?.previewLoading).toBe(false))

    const partialRes: HistoryCleanResponse = {
      removed: ["t1"],
      skipped: ["t2"],
      failed: [{ id: "t3", message: "permission denied" }],
    }
    ctx.cleanHistory.mockResolvedValueOnce(partialRes)
    await ctx.controller.confirm()

    const state = ctx.controller.getState()
    expect(state).not.toBeNull()
    expect(state?.cleaning).toBe(false)
    expect(state?.cleanResult).toEqual(partialRes)
    expect(ctx.onRemoved).toHaveBeenCalledWith(["t1"])

    // 已有结果后不可直接再次 confirm 旧候选。
    await ctx.controller.confirm()
    expect(ctx.cleanHistory).toHaveBeenCalledTimes(1)
  })

  it("分批中途报错时保留已清理项与部分结果", async () => {
    const ctx = setupController("/projects/alpha")
    ctx.previewHistory.mockResolvedValueOnce({
      tasks: [makeTask({ id: "t1" }), makeTask({ id: "t2" })],
    })
    ctx.controller.open()
    await vi.waitFor(() => expect(ctx.controller.getState()?.previewLoading).toBe(false))

    ctx.cleanHistory.mockRejectedValueOnce(
      new HistoryCleanPartialError(
        new ServiceApiError(500, "Internal server error"),
        { removed: ["t1"], skipped: [], failed: [] },
      ),
    )
    await ctx.controller.confirm()

    const state = ctx.controller.getState()
    expect(ctx.onRemoved).toHaveBeenCalledWith(["t1"])
    expect(state?.cleanResult).toEqual({ removed: ["t1"], skipped: [], failed: [] })
    expect(state?.cleanError).toBe("Internal server error")
  })
})
