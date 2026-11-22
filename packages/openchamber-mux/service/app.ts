import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http"
import { isSafeTaskId, MuxCommandError, type ManagedTask, type MuxManager } from "@misakacloud/opencode-mux-core"
import type {
  ErrorResponse, HealthResponse, InputBody, LogsResponse, PruneBody, PruneResponse,
  RestartTaskBody, RunBuildBody, RunBuildHttpResponse, ServiceActionBody,
  ServiceActionHttpResponse, SessionCloseBody, SessionCloseResponse, StopTaskBody, TasksResponse, TaskView,
} from "../src/types"

const MAX_BODY_BYTES = 64 * 1024
const MAX_INTEGER = 2_147_483_647
const MAX_BUILD_WAIT_MS = 15_000
const MISSING_BACKEND = "No tmux or psmux executable found"
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

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INTEGER) return value
  throw new HttpError(400, `Invalid ${field}`)
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
  return new HttpError(404, "Task not found")
}

function missingPane(error: unknown, id: string): boolean {
  return error instanceof Error && (error.message === `Mux task ${id} has no live pane`
    || (error instanceof MuxCommandError && ["capture-pane", "send-keys"].includes(error.subcommand)
      && /can't find pane|no such pane|pane not found|no server running|no sessions|no such file or directory/i.test(error.result.stderr)))
}

export function createServiceHandler({ manager, token }: ServiceOptions): RequestListener {
  const authorization = token ? `Bearer ${token}` : undefined
  const backendOrNull = async () => {
    try {
      return await manager.getBackend()
    } catch (error) {
      if (error instanceof Error && error.message === MISSING_BACKEND) return null
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
        let tail: string
        try {
          tail = await manager.captureLogs(id, lines)
        } catch (error) {
          if (missingPane(error, id)) throw taskNotFound()
          throw error
        }
        const task = (await manager.listTasks()).find((item) => item.id === id)
        if (!task || task.status === "gone" || task.forceStopped) throw taskNotFound()
        const { status, exitCode, attachCommand } = await view(task)
        return { id, status, exitCode, tail, attachCommand } satisfies LogsResponse
      }
      if (method === "POST" && operation === "input") {
        const body = await readBody(request)
        const input: InputBody = { input: text(body.input, "input", true), enter: optionalBoolean(body.enter, "enter") }
        try {
          await manager.sendInput(id, input.input, { enter: input.enter })
        } catch (error) {
          if (error instanceof Error && error.message === `Mux task ${id} is not running`) {
            throw new HttpError(409, "Task is not running")
          }
          if (missingPane(error, id)) throw taskNotFound()
          throw error
        }
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
      } else if (error instanceof Error && error.message === MISSING_BACKEND) {
        respond(response, 503, { error: MISSING_BACKEND } satisfies ErrorResponse)
      } else if (error instanceof Error && error.message === "A command is required for a new service") {
        respond(response, 400, { error: error.message } satisfies ErrorResponse)
      } else {
        console.error("Mux service request failed", error)
        respond(response, 500, { error: "Internal server error" } satisfies ErrorResponse)
      }
    })
  }
}

export function createServiceServer(options: ServiceOptions) {
  return createServer(createServiceHandler(options))
}
