import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http"
import { isSafeTaskId, MuxCommandError, MuxError, type HistoryCandidate, type ManagedTask, type MuxErrorCode, type MuxManager } from "@misakacloud/opencode-mux-core"
import type {
  ErrorResponse, HealthResponse, HistoryCleanBody, HistoryCleanResponse, HistoryPreviewBody,
  HistoryPreviewResponse, InputBody, LogsResponse, PruneBody, PruneResponse,
  RestartTaskBody, RunBuildBody, RunBuildHttpResponse, ServiceActionBody,
  ServiceActionHttpResponse, SessionCloseBody, SessionCloseResponse, StopTaskBody, TasksResponse, TaskView,
} from "../src/types"

const MAX_BODY_BYTES = 64 * 1024
const MAX_INTEGER = 2_147_483_647
const MAX_BUILD_WAIT_MS = 15_000
const TASK_NOT_FOUND = "Task not found"
const MUX_ERROR_STATUS: Partial<Record<MuxErrorCode, number>> = {
  BACKEND_UNAVAILABLE: 503,
  COMMAND_REQUIRED: 400,
  TASK_NO_LIVE_PANE: 404,
}
const ROLES = ["build", "service"] as const
const STATUSES = ["running", "succeeded", "failed", "stopped", "gone"] as const
const ACTIONS = ["start", "restart", "stop", "status", "remove"] as const

interface ServiceOptions {
  manager: MuxManager
  token: string
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }).end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const tooLarge = () => new HttpError(400, "JSON body exceeds 64 KiB")
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  // 不销毁入站流，才能向超过大小限制的客户端返回 400。
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw tooLarge()
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch {
    throw new HttpError(400, "Invalid JSON")
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Expected a JSON object")
  }
  return data as Record<string, unknown>
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0")) {
    throw new HttpError(400, `Invalid ${field}`)
  }
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value
  throw new HttpError(400, `Invalid ${field}`)
}

function integer(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INTEGER) return value
  throw new HttpError(400, `Invalid ${field}`)
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : integer(value, field)
}

function historyOptions(body: Record<string, unknown>): HistoryPreviewBody {
  return {
    cwd: text(body.cwd, "cwd"),
    includeShell: optionalBoolean(body.includeShell, "includeShell"),
    retentionDays: optionalInteger(body.retentionDays, "retentionDays"),
  }
}

function historyCandidates(value: unknown): HistoryCandidate[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Invalid candidates")
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "Invalid candidates")
    }
    const record = item as Record<string, unknown>
    return {
      id: text(record.id, "candidates.id"),
      updatedAt: text(record.updatedAt, "candidates.updatedAt"),
      restartCount: integer(record.restartCount, "candidates.restartCount"),
    }
  })
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T
function oneOf<T extends string>(value: unknown, field: string, values: readonly T[], optional: true): T | undefined
function oneOf<T extends string>(value: unknown, field: string, values: readonly T[], optional = false): T | undefined {
  if (value === undefined && optional) return undefined
  const match = values.find((item) => item === value)
  if (match === undefined) throw new HttpError(400, `Invalid ${field}`)
  return match
}

function taskNotFound(): HttpError {
  return new HttpError(404, TASK_NOT_FOUND)
}

async function withPane<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof MuxCommandError && error.isMissingPane) {
      throw new MuxError("TASK_NO_LIVE_PANE", error.message, { cause: error })
    }
    throw error
  }
}

export function createServiceHandler({ manager, token }: ServiceOptions): RequestListener {
  const authorization = token ? `Bearer ${token}` : undefined
  const backendOrNull = async () => {
    try {
      return await manager.getBackend()
    } catch (error) {
      if (error instanceof MuxError && error.code === "BACKEND_UNAVAILABLE") return null
      throw error
    }
  }
  const view = async (task: ManagedTask): Promise<TaskView> => ({ ...task, attachCommand: await manager.attachCommand(task) })
  const actionResponse = async (result: Awaited<ReturnType<MuxManager["serviceAction"]>>): Promise<ServiceActionHttpResponse> =>
    result.task ? { ...result, task: await view(result.task) } : { ok: result.ok, timedOut: result.timedOut }

  async function route(request: IncomingMessage): Promise<object> {
    if (authorization === undefined || request.headers.authorization !== authorization) {
      throw new HttpError(401, "Unauthorized")
    }
    const target = request.url
    if (!target?.startsWith("/") || target.startsWith("//")) throw new HttpError(400, "Invalid request target")
    const { pathname, searchParams } = new URL(target, "http://127.0.0.1")
    const method = request.method
    if (method === "GET" && pathname === "/health") {
      return { ok: true, backend: await backendOrNull() } satisfies HealthResponse
    }
    if (method === "GET" && pathname === "/tasks") {
      const filter = {
        cwd: optionalText(searchParams.get("cwd") ?? undefined, "cwd"),
        role: oneOf(searchParams.get("role") ?? undefined, "role", ROLES, true),
        status: oneOf(searchParams.get("status") ?? undefined, "status", STATUSES, true),
      }
      const backend = await backendOrNull()
      const tasks = backend ? await Promise.all((await manager.listTasks(filter)).map(view)) : []
      return { tasks, backend } satisfies TasksResponse
    }
    if (method === "POST" && pathname === "/builds") {
      const body = await readBody(request)
      const input: RunBuildBody = {
        name: text(body.name, "name"),
        command: text(body.command, "command"),
        cwd: text(body.cwd, "cwd"),
        wait: optionalBoolean(body.wait, "wait") ?? false,
        timeoutMs: optionalInteger(body.timeoutMs, "timeoutMs"),
        tailLines: optionalInteger(body.tailLines, "tailLines"),
      }
      if (input.wait) input.timeoutMs = Math.min(input.timeoutMs ?? MAX_BUILD_WAIT_MS, MAX_BUILD_WAIT_MS)
      const result = await manager.runBuild({ ...input, source: "openchamber" })
      return { ...result, task: await view(result.task) } satisfies RunBuildHttpResponse
    }
    if (method === "POST" && pathname === "/services") {
      const body = await readBody(request)
      const input: ServiceActionBody = {
        action: oneOf(body.action, "action", ACTIONS),
        name: text(body.name, "name"),
        cwd: text(body.cwd, "cwd"),
        command: optionalText(body.command, "command"),
        restartIfRunning: optionalBoolean(body.restartIfRunning, "restartIfRunning"),
        force: optionalBoolean(body.force, "force"),
        timeoutMs: optionalInteger(body.timeoutMs, "timeoutMs"),
      }
      return actionResponse(await manager.serviceAction({ ...input, source: "openchamber" }))
    }
    if (method === "POST" && pathname === "/prune") {
      const body = await readBody(request)
      const filter: PruneBody = {
        cwd: optionalText(body.cwd, "cwd"),
        role: oneOf(body.role, "role", ROLES, true),
      }
      return { pruned: await manager.pruneGone(filter) } satisfies PruneResponse
    }
    if (method === "POST" && pathname === "/history/preview") {
      const body = await readBody(request)
      const input = historyOptions(body)
      return { tasks: await manager.previewHistory(input) } satisfies HistoryPreviewResponse
    }
    if (method === "POST" && pathname === "/history/clean") {
      const body = await readBody(request)
      const input: HistoryCleanBody = {
        ...historyOptions(body),
        candidates: historyCandidates(body.candidates),
      }
      return (await manager.cleanHistory(input)) satisfies HistoryCleanResponse
    }
    if (method === "POST" && pathname === "/session/close") {
      const body = await readBody(request)
      const input: SessionCloseBody = { cwd: text(body.cwd, "cwd") }
      return (await manager.closeSession(input)) satisfies SessionCloseResponse
    }

    const taskRoute = /^\/tasks\/([^/]+)(?:\/(restart|stop|logs|input))?$/.exec(pathname)
    if (taskRoute) {
      let id: string
      try {
        id = decodeURIComponent(taskRoute[1])
      } catch {
        throw new HttpError(400, "Invalid task ID")
      }
      if (!isSafeTaskId(id)) throw taskNotFound()
      const operation = taskRoute[2]
      if (method === "POST" && operation === "restart") {
        const body = await readBody(request)
        const input: RestartTaskBody = { command: optionalText(body.command, "command") }
        const result = await manager.restartTask(id, { ...input, source: "openchamber" })
        if (!result.task) throw taskNotFound()
        return actionResponse(result)
      }
      if (method === "POST" && operation === "stop") {
        const body = await readBody(request)
        const input: StopTaskBody = {
          force: optionalBoolean(body.force, "force"),
          timeoutMs: optionalInteger(body.timeoutMs, "timeoutMs"),
        }
        const result = await manager.stopTask(id, input)
        if (!result.task) throw taskNotFound()
        return actionResponse(result)
      }
      if (method === "DELETE" && operation === undefined) {
        const result = await manager.removeTask(id)
        if (!result.task) throw taskNotFound()
        return actionResponse(result)
      }
      if (method === "GET" && operation === "logs") {
        const value = searchParams.get("lines") ?? "120"
        if (!/^\d+$/.test(value)) throw new HttpError(400, "Invalid lines")
        const lines = optionalInteger(Number(value), "lines")
        const tail = await withPane(() => manager.captureLogs(id, lines))
        const task = (await manager.listTasks()).find((item) => item.id === id)
        if (!task || task.status === "gone" || task.forceStopped) throw taskNotFound()
        const { status, exitCode, attachCommand } = await view(task)
        return { id, status, exitCode, tail, attachCommand } satisfies LogsResponse
      }
      if (method === "POST" && operation === "input") {
        const body = await readBody(request)
        const input: InputBody = { input: text(body.input, "input", true), enter: optionalBoolean(body.enter, "enter") }
        await withPane(() => manager.sendInput(id, input.input, { enter: input.enter }))
        return { ok: true }
      }
    }
    throw new HttpError(404, "Not found")
  }

  return (request, response) => {
    void route(request).then((body) => respond(response, 200, body)).catch((error: unknown) => {
      // 鉴权失败或请求体过大时也要继续丢弃未读取的内容。
      request.resume()
      if (response.destroyed || response.headersSent) return
      if (error instanceof HttpError) {
        respond(response, error.status, { error: error.message } satisfies ErrorResponse)
        return
      }
      const status = error instanceof MuxError ? MUX_ERROR_STATUS[error.code] : undefined
      if (error instanceof MuxError && status !== undefined) {
        const message = error.code === "TASK_NO_LIVE_PANE" ? TASK_NOT_FOUND : error.message
        respond(response, status, { error: message, code: error.code } satisfies ErrorResponse & { code: MuxErrorCode })
        return
      }
      console.error("Mux service request failed", error)
      respond(response, 500, { error: "Internal server error" } satisfies ErrorResponse)
    })
  }
}

export function createServiceServer(options: ServiceOptions) {
  return createServer(createServiceHandler(options))
}
