import { HostRequestError, type HostClient, type HostRequestErrorCode } from "@openchamber/sdk"
import type { TaskRole, TaskStatus } from "@misakacloud/opencode-mux-core"
import type {
  ErrorResponse,
  HealthResponse,
  InputBody,
  LogsResponse,
  PruneBody,
  PruneResponse,
  RestartTaskBody,
  RunBuildBody,
  RunBuildHttpResponse,
  ServiceActionBody,
  ServiceActionHttpResponse,
  SessionCloseBody,
  SessionCloseResponse,
  StopTaskBody,
  TasksResponse,
} from "../types"

export class ServiceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = "ServiceApiError"
  }
}

export interface FormattedError {
  code?: HostRequestErrorCode | number
  title: string
  detail: string
  setupRequired: boolean
}

const SETUP_CODES = new Set<HostRequestErrorCode>([
  "NO_SERVICE",
  "NOT_GRANTED",
  "DISABLED",
  "SERVICE_FAILED",
])

const SERVICE_CODE_MAP = new Map([
  ["TASK_NO_LIVE_PANE", "未找到该任务，可能已被移除或终端窗格已失效"],
  ["BACKEND_UNAVAILABLE", "未检测到 tmux 或 psmux，请先安装后重试"],
  ["COMMAND_REQUIRED", "首次启动服务需要填写启动命令"],
])

// 兼容尚未返回错误码的服务。
const SERVICE_MESSAGE_MAP = new Map([
  ["Task not found", SERVICE_CODE_MAP.get("TASK_NO_LIVE_PANE")],
  ["Task is not running", "任务当前未在运行，无法发送输入"],
  ["No tmux or psmux executable found", SERVICE_CODE_MAP.get("BACKEND_UNAVAILABLE")],
  ["A command is required for a new service", SERVICE_CODE_MAP.get("COMMAND_REQUIRED")],
  ["Unauthorized", "本地服务鉴权失败"],
])

export function formatClientError(error: unknown): FormattedError {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case "NO_SERVICE":
        return {
          code: error.code,
          title: "Mux 本地服务未运行",
          detail: "请确认已在 OpenChamber 扩展设置中启用并授权 Mux Tasks 后台服务。",
          setupRequired: true,
        }
      case "NOT_GRANTED":
        return {
          code: error.code,
          title: "尚未获得扩展授权",
          detail: "请在扩展设置中允许 Mux Tasks 运行本地复用器命令后重试。",
          setupRequired: true,
        }
      case "DISABLED":
        return {
          code: error.code,
          title: "扩展已暂停",
          detail: "Mux Tasks 当前在 OpenChamber 设置中处于停用状态。",
          setupRequired: true,
        }
      case "SERVICE_FAILED":
        return {
          code: error.code,
          title: "本地服务启动失败",
          detail: error.message || "Mux 后台服务未能成功就绪，请尝试重新连接。",
          setupRequired: true,
        }
      case "REQUEST_FAILED":
        return {
          code: error.code,
          title: "服务请求无响应",
          detail: "请求已发出但未收到有效答复，请稍后刷新确认任务状态。",
          setupRequired: false,
        }
      case "HOST_TIMEOUT":
        return {
          code: error.code,
          title: "宿主通信超时",
          detail: "等待本地服务响应超时，请稍后重试。",
          setupRequired: false,
        }
      case "HOST_UNAVAILABLE":
        return {
          code: error.code,
          title: "宿主环境不可用",
          detail: "当前页面未运行在 OpenChamber 宿主框架中。",
          setupRequired: true,
        }
      default:
        return {
          code: error.code,
          title: "操作未能完成",
          detail: error.message || `宿主返回错误 (${error.code})`,
          setupRequired: SETUP_CODES.has(error.code),
        }
    }
  }

  if (error instanceof ServiceApiError) {
    const mapped = error.code === undefined ? SERVICE_MESSAGE_MAP.get(error.message) : SERVICE_CODE_MAP.get(error.code)
    return {
      code: error.status,
      title: `请求失败 (${error.status})`,
      detail: mapped ?? error.message,
      setupRequired: false,
    }
  }

  if (error instanceof Error) {
    return {
      title: "发生异常",
      detail: error.message,
      setupRequired: false,
    }
  }

  return {
    title: "发生未知错误",
    detail: String(error),
    setupRequired: false,
  }
}

export interface ListTasksParams {
  cwd?: string
  role?: TaskRole
  status?: TaskStatus
}

export interface MuxClient {
  health: () => Promise<HealthResponse>
  listTasks: (params?: ListTasksParams) => Promise<TasksResponse>
  runBuild: (body: RunBuildBody) => Promise<RunBuildHttpResponse>
  serviceAction: (body: ServiceActionBody) => Promise<ServiceActionHttpResponse>
  restartTask: (id: string, body?: RestartTaskBody) => Promise<ServiceActionHttpResponse>
  stopTask: (id: string, body?: StopTaskBody) => Promise<ServiceActionHttpResponse>
  removeTask: (id: string) => Promise<ServiceActionHttpResponse>
  closeSession: (body: SessionCloseBody) => Promise<SessionCloseResponse>
  getLogs: (id: string, lines?: number) => Promise<LogsResponse>
  sendInput: (id: string, body: InputBody) => Promise<{ ok: boolean }>
  prune: (body?: PruneBody) => Promise<PruneResponse>
}

function parseJsonBody<T>(raw: string, status: number): T {
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ServiceApiError(status, "服务返回了无法解析的响应内容")
  }
}

export function createMuxClient(host: HostClient): MuxClient {
  async function requestJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; requireBody?: boolean } = {},
  ): Promise<T> {
    const query: Record<string, string> = {}
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== "") query[key] = value
      }
    }
    const result = await host.serviceRequest({
      method,
      path,
      query: Object.keys(query).length > 0 ? query : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
    if (result.status >= 400) {
      let message = `HTTP ${result.status}`
      let code: string | undefined
      try {
        const parsed = JSON.parse(result.body) as Partial<ErrorResponse> & { code?: unknown }
        if (typeof parsed.error === "string" && parsed.error) message = parsed.error
        if (typeof parsed.code === "string" && parsed.code) code = parsed.code
      } catch {
        if (result.body) message = result.body
      }
      throw new ServiceApiError(result.status, message, code)
    }
    if (options.requireBody && !result.body) {
      throw new ServiceApiError(result.status, "服务返回了空响应")
    }
    return parseJsonBody<T>(result.body, result.status)
  }

  return {
    health: () => requestJson<HealthResponse>("GET", "/health"),
    listTasks: (params) =>
      requestJson<TasksResponse>("GET", "/tasks", {
        query: params
          ? { cwd: params.cwd, role: params.role, status: params.status }
          : undefined,
      }),
    runBuild: (body) => requestJson<RunBuildHttpResponse>("POST", "/builds", { body }),
    serviceAction: (body) => requestJson<ServiceActionHttpResponse>("POST", "/services", { body }),
    restartTask: (id, body = {}) =>
      requestJson<ServiceActionHttpResponse>("POST", `/tasks/${encodeURIComponent(id)}/restart`, { body }),
    stopTask: (id, body = {}) =>
      requestJson<ServiceActionHttpResponse>("POST", `/tasks/${encodeURIComponent(id)}/stop`, { body }),
    removeTask: (id) =>
      requestJson<ServiceActionHttpResponse>("DELETE", `/tasks/${encodeURIComponent(id)}`),
    closeSession: async (body) => {
      try {
        return await requestJson<SessionCloseResponse>("POST", "/session/close", { body, requireBody: true })
      } catch (error) {
        if (error instanceof ServiceApiError && error.status === 404 &&
          (error.message === "HTTP 404" || error.message === "Not found")) {
          throw new ServiceApiError(404, "未找到对应会话，或当前本地服务不支持关闭会话")
        }
        throw error
      }
    },
    getLogs: (id, lines = 120) =>
      requestJson<LogsResponse>("GET", `/tasks/${encodeURIComponent(id)}/logs`, {
        query: { lines: String(lines) },
      }),
    sendInput: (id, body) =>
      requestJson<{ ok: boolean }>("POST", `/tasks/${encodeURIComponent(id)}/input`, { body }),
    prune: (body = {}) => {
      const payload: PruneBody = {}
      if (body.cwd && body.cwd.trim()) payload.cwd = body.cwd
      if (body.role) payload.role = body.role
      return requestJson<PruneResponse>("POST", "/prune", { body: payload })
    },
  }
}

export async function copyTextWithToast(
  host: HostClient,
  text: string,
  successMessage = "已复制到剪贴板",
): Promise<boolean> {
  try {
    await host.writeClipboard(text)
    await host.toast({ kind: "success", message: successMessage })
    return true
  } catch (error) {
    const formatted = formatClientError(error)
    await host.toast({ kind: "error", message: `复制失败：${formatted.detail}` }).catch(() => {})
    return false
  }
}
