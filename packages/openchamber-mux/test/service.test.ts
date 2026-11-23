import { once } from "node:events"
import { request } from "node:http"
import { MuxCommandError, MuxError, type ManagedTask, type MuxManager } from "@misakacloud/opencode-mux-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServiceServer } from "../service/app"

const token = "test-host-token"
const backend = { kind: "tmux", executable: "tmux" } as const
const task = {
  id: "task-1", role: "build", name: "compile", cwd: "/projects/with space",
  command: "bun run compile", status: "running", muxKind: "tmux", muxSession: "oc-project-a",
  paneId: "%1", restartCount: 0, createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z",
} satisfies ManagedTask
const attachCommand = "'tmux' 'attach-session' '-t' '=oc-project-a'"
const view = { ...task, attachCommand }

function fakeManager() {
  return {
    getBackend: vi.fn<MuxManager["getBackend"]>().mockResolvedValue(backend),
    listTasks: vi.fn<MuxManager["listTasks"]>().mockResolvedValue([task]),
    attachCommand: vi.fn<MuxManager["attachCommand"]>().mockResolvedValue(attachCommand),
    runBuild: vi.fn<MuxManager["runBuild"]>().mockResolvedValue({ ok: true, task, tail: "output", timedOut: false }),
    serviceAction: vi.fn<MuxManager["serviceAction"]>().mockResolvedValue({ ok: true, task: { ...task, role: "service" } }),
    restartTask: vi.fn<MuxManager["restartTask"]>().mockResolvedValue({ ok: true, task }),
    stopTask: vi.fn<MuxManager["stopTask"]>().mockResolvedValue({ ok: true, task: { ...task, status: "stopped" } }),
    removeTask: vi.fn<MuxManager["removeTask"]>().mockResolvedValue({ ok: true, task }),
    closeSession: vi.fn<MuxManager["closeSession"]>().mockResolvedValue({ ok: true, removed: 2, sessionName: task.muxSession }),
    captureLogs: vi.fn<MuxManager["captureLogs"]>().mockResolvedValue("captured\noutput"),
    sendInput: vi.fn<MuxManager["sendInput"]>().mockResolvedValue(undefined),
    pruneGone: vi.fn<MuxManager["pruneGone"]>().mockResolvedValue([{ ...task, status: "gone" }]),
    previewHistory: vi.fn<MuxManager["previewHistory"]>().mockResolvedValue([{ ...task, status: "gone" }]),
    cleanHistory: vi.fn<MuxManager["cleanHistory"]>().mockResolvedValue({
      removed: [task.id], skipped: [], failed: [],
    }),
  } satisfies MuxManager
}

describe("OpenChamber Mux HTTP service", () => {
  let manager: ReturnType<typeof fakeManager>
  let server: ReturnType<typeof createServiceServer>
  let port: number

  beforeEach(async () => {
    manager = fakeManager()
    server = createServiceServer({ manager, token }).listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected TCP address")
    port = address.port
  })

  afterEach(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  })

  async function call(path: string, options: RequestInit = {}, auth: string | null = `Bearer ${token}`) {
    const headers = new Headers(options.headers)
    if (auth !== null) headers.set("Authorization", auth)
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers })
    return { status: response.status, body: await response.json() }
  }

  function post(path: string, body?: object) {
    return call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
  }

  it("authenticates health, mutations, and unknown routes before routing or parsing", async () => {
    const unauthorized = { status: 401, body: { error: "Unauthorized" } }
    expect(await call("/health", {}, null)).toEqual(unauthorized)
    expect(await call("/health", {}, `Bearer ${token}-wrong`)).toEqual(unauthorized)
    expect(await call("/health", {}, `Basic ${token}`)).toEqual(unauthorized)
    expect(await call("/builds", { method: "POST", body: "not JSON" }, null)).toEqual(unauthorized)
    expect(await call("/nope", {}, null)).toEqual(unauthorized)
    expect(manager.getBackend).not.toHaveBeenCalled()
    expect(manager.runBuild).not.toHaveBeenCalled()
  })

  it("reports healthy with the detected backend", async () => {
    expect(await call("/health")).toEqual({ status: 200, body: { ok: true, backend } })
  })

  it("keeps the service ready and lists no tasks if neither backend is installed", async () => {
    manager.getBackend.mockRejectedValue(new MuxError("BACKEND_UNAVAILABLE", "Backend binary missing"))
    expect(await call("/health")).toEqual({ status: 200, body: { ok: true, backend: null } })
    expect(await call("/tasks")).toEqual({ status: 200, body: { tasks: [], backend: null } })
    expect(manager.listTasks).not.toHaveBeenCalled()
    expect(manager.attachCommand).not.toHaveBeenCalled()
  })

  it("lists filtered tasks with their attach commands", async () => {
    expect(await call(`/tasks?cwd=${encodeURIComponent(task.cwd)}&role=build&status=running`))
      .toEqual({ status: 200, body: { tasks: [view], backend } })
    expect(manager.listTasks).toHaveBeenCalledWith({ cwd: task.cwd, role: "build", status: "running" })
    expect(manager.attachCommand).toHaveBeenCalledWith(task)
  })

  it("关闭项目会话并返回清理数；拒绝缺少 cwd 的请求", async () => {
    expect(await post("/session/close")).toEqual({ status: 400, body: { error: "Invalid cwd" } })
    expect(manager.closeSession).not.toHaveBeenCalled()
    expect(await post("/session/close", { cwd: task.cwd })).toEqual({
      status: 200, body: { ok: true, removed: 2, sessionName: task.muxSession },
    })
    expect(manager.closeSession).toHaveBeenCalledWith({ cwd: task.cwd })
  })

  const build = { name: task.name, cwd: task.cwd, command: task.command }

  it("returns 503 with the backend error code for mutations", async () => {
    const error = new MuxError("BACKEND_UNAVAILABLE", "No tmux or psmux executable found")
    manager.runBuild.mockRejectedValueOnce(error)
    expect(await post("/builds", build)).toEqual({
      status: 503, body: { error: error.message, code: "BACKEND_UNAVAILABLE" },
    })
  })

  it("starts builds asynchronously by default and does not trust a supplied source", async () => {
    expect(await post("/builds", { ...build, source: "ai" }))
      .toEqual({ status: 200, body: { ok: true, task: view, tail: "output", timedOut: false } })
    expect(manager.runBuild).toHaveBeenCalledWith(expect.objectContaining({ ...build, wait: false, source: "openchamber" }))
  })

  it.each([[undefined, 15_000], [120_000, 15_000], [3_000, 3_000], [0, 0]])(
    "waits for a requested build with timeout %s normalized to %s",
    async (timeoutMs, expected) => {
      expect((await post("/builds", { ...build, wait: true, timeoutMs, tailLines: 25 })).status).toBe(200)
      expect(manager.runBuild).toHaveBeenCalledWith({ ...build, wait: true, timeoutMs: expected, tailLines: 25, source: "openchamber" })
    },
  )

  it("dispatches named service operations and serializes a result with or without a task", async () => {
    const input = { name: "watch", cwd: task.cwd, command: "bun run watch", action: "start", restartIfRunning: true }
    expect(await post("/services", input))
      .toEqual({ status: 200, body: { ok: true, task: { ...view, role: "service" } } })
    expect(manager.serviceAction).toHaveBeenCalledWith(expect.objectContaining({ ...input, source: "openchamber" }))
    manager.serviceAction.mockResolvedValueOnce({ ok: false })
    expect(await post("/services", { action: "status", name: "unknown", cwd: task.cwd }))
      .toEqual({ status: 200, body: { ok: false } })
  })

  it("restarts a task with OpenChamber source and an optional new command", async () => {
    expect(await post(`/tasks/${task.id}/restart`, { command: "bun run rebuild", source: "human" }))
      .toEqual({ status: 200, body: { ok: true, task: view } })
    expect(manager.restartTask).toHaveBeenCalledWith(task.id, { command: "bun run rebuild", source: "openchamber" })
    expect((await post(`/tasks/${task.id}/restart`)).status).toBe(200)
  })

  it("stops a task, passing force and timeout and preserving an unsuccessful result for an existing task", async () => {
    const input = { force: true, timeoutMs: 1_000 }
    expect(await post(`/tasks/${task.id}/stop`, input))
      .toEqual({ status: 200, body: { ok: true, task: { ...view, status: "stopped" } } })
    expect(manager.stopTask).toHaveBeenCalledWith(task.id, input)
    manager.stopTask.mockResolvedValueOnce({ ok: false, timedOut: true, task })
    expect(await post(`/tasks/${task.id}/stop`))
      .toEqual({ status: 200, body: { ok: false, timedOut: true, task: view } })
  })

  it("deletes a task", async () => {
    expect(await call(`/tasks/${task.id}`, { method: "DELETE" })).toEqual({ status: 200, body: { ok: true, task: view } })
    expect(manager.removeTask).toHaveBeenCalledWith(task.id)
  })

  it("captures logs with the default or requested line count and includes task metadata", async () => {
    manager.listTasks.mockResolvedValue([{ ...task, status: "failed", exitCode: 7 }])
    const result = {
      status: 200,
      body: { id: task.id, status: "failed", exitCode: 7, tail: "captured\noutput", attachCommand },
    }
    expect(await call(`/tasks/${task.id}/logs`)).toEqual(result)
    expect(await call(`/tasks/${task.id}/logs?lines=25`)).toEqual(result)
    expect(manager.captureLogs.mock.calls).toEqual([[task.id, 120], [task.id, 25]])
  })

  it("sends literal input and an optional Enter, allowing an empty string for Enter alone", async () => {
    expect(await post(`/tasks/${task.id}/input`, { input: "  text;  ", enter: false })).toEqual({ status: 200, body: { ok: true } })
    expect(await post(`/tasks/${task.id}/input`, { input: "", enter: true })).toEqual({ status: 200, body: { ok: true } })
    expect(manager.sendInput.mock.calls).toEqual([[task.id, "  text;  ", { enter: false }], [task.id, "", { enter: true }]])
  })

  it("returns 404 for missing tasks and panes, including a pane disappearing during log capture", async () => {
    const id = "not-found"
    const missing = { status: 404, body: { error: "Task not found" } }
    const missingPane = { status: 404, body: { error: "Task not found", code: "TASK_NO_LIVE_PANE" } }
    manager.restartTask.mockResolvedValueOnce({ ok: false })
    manager.stopTask.mockResolvedValueOnce({ ok: false })
    manager.removeTask.mockResolvedValueOnce({ ok: false })
    const error = new MuxError("TASK_NO_LIVE_PANE", "The target pane is unavailable")
    manager.sendInput.mockRejectedValueOnce(error)
    manager.captureLogs.mockRejectedValueOnce(error)
    expect(await post(`/tasks/${id}/restart`)).toEqual(missing)
    expect(await post(`/tasks/${id}/stop`)).toEqual(missing)
    expect(await call(`/tasks/${id}`, { method: "DELETE" })).toEqual(missing)
    expect(await post(`/tasks/${id}/input`, { input: "x" })).toEqual(missingPane)
    expect(await call(`/tasks/${id}/logs`)).toEqual(missingPane)
    manager.captureLogs.mockRejectedValueOnce(new MuxCommandError("capture-pane", {
      exitCode: 1, stdout: "", stderr: "can't find pane: %1",
    }))
    expect(await call(`/tasks/${task.id}/logs`)).toEqual(missingPane)
    manager.listTasks.mockResolvedValueOnce([])
    expect(await call(`/tasks/${task.id}/logs`)).toEqual(missing)
  })

  it("prunes only with the supplied cwd and role filter", async () => {
    const filter = { cwd: task.cwd, role: "build" }
    expect(await post("/prune", filter)).toEqual({ status: 200, body: { pruned: [{ ...task, status: "gone" }] } })
    expect(manager.pruneGone).toHaveBeenCalledWith(filter)
  })

  it("previews and cleans project history with strict input validation", async () => {
    const previewInput = { cwd: task.cwd, includeShell: true, retentionDays: 14 }
    expect(await post("/history/preview", previewInput)).toEqual({
      status: 200,
      body: { tasks: [{ ...task, status: "gone" }] },
    })
    expect(manager.previewHistory).toHaveBeenCalledWith(previewInput)

    const cleanInput = {
      cwd: task.cwd,
      includeShell: false,
      retentionDays: 7,
      candidates: [{ id: task.id, updatedAt: task.updatedAt, restartCount: 0 }],
    }
    expect(await post("/history/clean", cleanInput)).toEqual({
      status: 200,
      body: { removed: [task.id], skipped: [], failed: [] },
    })
    expect(manager.cleanHistory).toHaveBeenCalledWith(cleanInput)

    expect(await post("/history/clean", { cwd: task.cwd, candidates: [] })).toEqual({
      status: 200,
      body: { removed: [task.id], skipped: [], failed: [] },
    })
  })

  it("returns 503 for history endpoints when mux backend is unavailable", async () => {
    const error = new MuxError("BACKEND_UNAVAILABLE", "No tmux or psmux executable found")
    manager.previewHistory.mockRejectedValueOnce(error)
    expect(await post("/history/preview", { cwd: task.cwd })).toEqual({
      status: 503,
      body: { error: error.message, code: "BACKEND_UNAVAILABLE" },
    })
  })

  it("rejects invalid JSON, non-object JSON, missing fields, and invalid field/query values", async () => {
    expect(await call("/builds", { method: "POST", body: "{oops" })).toEqual({ status: 400, body: { error: "Invalid JSON" } })
    expect((await call("/prune", { method: "POST", body: "[]" })).status).toBe(400)
    expect((await post("/builds", { name: task.name })).status).toBe(400)
    expect((await post("/builds", { ...build, wait: "true" })).status).toBe(400)
    expect((await post("/builds", { ...build, timeoutMs: -1 })).status).toBe(400)
    expect((await post("/services", { action: "launch", name: "watch", cwd: task.cwd })).status).toBe(400)
    expect((await post(`/tasks/${task.id}/restart`, { command: " \n " })).status).toBe(400)
    expect((await post(`/tasks/${task.id}/stop`, { force: 1 })).status).toBe(400)
    expect((await post(`/tasks/${task.id}/input`, {})).status).toBe(400)
    expect((await post("/prune", { role: "other" })).status).toBe(400)
    expect((await post("/history/preview", {})).status).toBe(400)
    expect((await post("/history/preview", { cwd: "   " })).status).toBe(400)
    expect((await post("/history/preview", { cwd: task.cwd, includeShell: "yes" })).status).toBe(400)
    expect((await post("/history/preview", { cwd: task.cwd, retentionDays: -1 })).status).toBe(400)
    expect((await post("/history/preview", { cwd: task.cwd, retentionDays: 1.5 })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: "bad" })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: [null] })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: [{ id: "", updatedAt: task.updatedAt, restartCount: 0 }] })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: [{ id: task.id, updatedAt: "", restartCount: 0 }] })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: [{ id: task.id, updatedAt: task.updatedAt, restartCount: -1 }] })).status).toBe(400)
    expect((await post("/history/clean", { cwd: task.cwd, candidates: [{ id: task.id, updatedAt: task.updatedAt }] })).status).toBe(400)
    expect((await call("/tasks?status=waiting")).status).toBe(400)
    expect((await call(`/tasks/${task.id}/logs?lines=1e3`)).status).toBe(400)
    expect(manager.runBuild).not.toHaveBeenCalled()
    expect(manager.sendInput).not.toHaveBeenCalled()
    expect(manager.previewHistory).not.toHaveBeenCalled()
    expect(manager.cleanHistory).not.toHaveBeenCalled()
  })

  it("returns 400 when starting a new service without the required command", async () => {
    const error = new MuxError("COMMAND_REQUIRED", "No launch command supplied")
    manager.serviceAction.mockRejectedValueOnce(error)
    expect(await post("/services", { action: "start", name: "watch", cwd: task.cwd }))
      .toEqual({ status: 400, body: { error: error.message, code: "COMMAND_REQUIRED" } })
  })

  it("limits both fixed-length and chunked bodies by bytes", async () => {
    const oversized = JSON.stringify({ input: "中".repeat(24_000) })
    const tooLarge = { status: 400, body: { error: "JSON body exceeds 64 KiB" } }
    expect(await call(`/tasks/${task.id}/input`, { method: "POST", body: oversized })).toEqual(tooLarge)
    const chunked = await new Promise<unknown>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port, path: `/tasks/${task.id}/input`, method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Transfer-Encoding": "chunked" },
      }, (res) => {
        res.setEncoding("utf8")
        let body = ""
        res.on("data", (chunk) => { body += chunk })
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }) }
          catch (error) { reject(error) }
        })
        res.on("error", reject)
      })
      req.on("error", reject)
      req.write(oversized.slice(0, 16_000))
      req.end(oversized.slice(16_000))
    })
    expect(chunked).toEqual(tooLarge)
    expect(manager.sendInput).not.toHaveBeenCalled()
  })
})
