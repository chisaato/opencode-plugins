import { resolve } from "node:path"
import type {
  HistoryCandidate, HistoryOptions, ManagedTask, MuxManager, RunBuildOptions,
  ServiceActionOptions, ServiceActionResult, TaskFilter, TaskRole, TaskStatus,
} from "@misakacloud/opencode-mux-core"

export const MAX_MUX_INTEGER = 2_147_483_647
const ROLES = ["build", "service"]
const STATUSES = ["running", "succeeded", "failed", "stopped", "gone"]
const ACTIONS = ["start", "restart", "stop", "status", "remove"]

export interface MuxToolDefaults {
  defaultTimeoutMs?: number
  defaultTailLines?: number
}

type ToolManager = Pick<MuxManager,
  "runBuild" | "serviceAction" | "restartTask" | "removeTask" | "closeSession" | "captureLogs" | "sendInput"
  | "listTasks" | "pruneGone" | "attachCommand" | "previewHistory" | "cleanHistory">
type ToolContext = { sessionID?: string }
type Selector = { id?: string; name?: string; role?: TaskRole; cwd?: string }
type BuildInput = Omit<RunBuildOptions, "cwd" | "source" | "sessionId"> & { cwd?: string }
type ServiceInput = Omit<ServiceActionOptions, "cwd" | "source" | "sessionId"> & { cwd?: string; tailLines?: number }
type ListInput = { cwd?: string; all?: boolean; role?: TaskRole; status?: TaskStatus; pruneGone?: boolean }
type HistoryInput = Omit<HistoryOptions, "cwd"> & { cwd?: string; candidates?: HistoryCandidate[] }

const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })
const integer = (description: string) => ({ type: "integer", minimum: 0, maximum: MAX_MUX_INTEGER, description })
const choices = (values: string[], description: string) => ({ type: "string", enum: values, description })
const name = str("任务名称。")
const cwd = str("工作目录；相对路径以当前项目目录为基准。")
const command = str("在独立终端 pane 中执行的命令。")
const role = choices(ROLES, "任务类型。")
const timeoutMs = integer("等待时限（毫秒）；超时不会自动终止任务。")
const tailLines = integer("返回最近的日志行数；0 不抓取日志。")
const selector = { id: str("唯一任务 ID；提供后优先于名称。"), name, role, cwd }

type InputSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

function schema(properties: Record<string, unknown>, required?: string[]): InputSchema {
  return { type: "object", properties, ...(required && { required }), additionalProperties: false }
}

function report(text: string, metadata: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], metadata }
}

function tool<T>(
  name: string, description: string, input: InputSchema,
  execute: (input: T, context?: ToolContext) => Promise<ReturnType<typeof report>>,
) {
  return { name, description, input, execute: (args: unknown, context?: ToolContext) => execute((args ?? {}) as T, context) }
}

function taskSummary(task: ManagedTask) {
  const { id, name, role, cwd, status, exitCode, restartCount, muxSession, paneId, shell } = task
  return { id, name, role, cwd, status, exitCode: exitCode ?? null, restartCount, muxSession, paneId, ...(shell && { shell }) }
}

type AttachedTask = ReturnType<typeof taskSummary> & { attachCommand: string }

function taskText(task: AttachedTask) {
  const exit = task.exitCode === null ? "" : ` exitCode=${task.exitCode}`
  return `[${task.status}] ${task.role} ${task.name} id=${task.id}${exit}${task.shell ? " shell=驻留" : ""} restartCount=${task.restartCount}`
    + `\n  cwd=${task.cwd} muxSession=${task.muxSession} paneId=${task.paneId}\n  attach: ${task.attachCommand}`
}

/** 创建 V2 工具；宿主负责按 JSON Schema 校验入参。 */
export function createMuxTools(manager: ToolManager, projectDirectory: string, defaults: MuxToolDefaults = {}) {
  const workingDirectory = (directory?: string) => resolve(projectDirectory, directory ?? ".")
  const origin = (context?: ToolContext) => ({ source: "ai" as const, sessionId: context?.sessionID })
  const attach = async (task: ManagedTask): Promise<AttachedTask> => ({
    ...taskSummary(task), attachCommand: await manager.attachCommand(task),
  })

  // 名称可能横跨多个目录或角色，绝不猜测要操作哪个任务。
  async function resolveTask({ id, name, role, cwd }: Selector) {
    if (!id && !name) {
      return { error: report("请提供任务 id 或 name。可先调用 mux_list 查找任务。", {
        ok: false, error: "missing_selector",
      }) }
    }
    const matches = id
      ? (await manager.listTasks()).filter((task) => task.id === id)
      : await manager.listTasks({ name, role, cwd: cwd === undefined ? undefined : workingDirectory(cwd) })
    if (matches.length === 0) {
      return { error: report(`未找到任务 ${id ?? name}。可调用 mux_list 核对任务。`, {
        ok: false, error: "task_not_found",
      }) }
    }
    if (matches.length > 1) {
      const candidates = matches.map(taskSummary)
      return { error: report(
        `任务名称 ${name} 不唯一。请指定 id，或补充 role/cwd：\n`
          + candidates.map((t) => `- id=${t.id} role=${t.role} cwd=${t.cwd} status=${t.status}`).join("\n"),
        { ok: false, error: "ambiguous_task", candidates },
      ) }
    }
    return { task: matches[0] }
  }

  async function actionReport(label: string, result: ServiceActionResult, lines: number, removed = false) {
    const { ok, task, timedOut = false } = result
    if (!task) return report(`${label}：未找到任务。`, { ok, status: "not_found", timedOut, tail: "" })

    let tail = ""
    let tailError: string | undefined
    // 可选尾部日志不应让已完成的操作失败，例如读日志前 pane 被人工关闭。
    if (!removed && task.status !== "gone" && !task.forceStopped && lines !== 0) {
      try {
        tail = await manager.captureLogs(task.id, lines)
      } catch (error) {
        tailError = error instanceof Error ? error.message : String(error)
      }
    }
    const info = await attach(task)
    const status = removed && ok ? "removed" : info.status
    return report([
      `${label}：${status}（ok=${ok}）`,
      taskText(info),
      timedOut && "等待停止超时；pane 仍可附加，也可以重试停止。",
      tailError && `未能获取尾部日志：${tailError}`,
      tail && `日志尾部：\n${tail}`,
    ].filter(Boolean).join("\n"), {
      ...info, ok, status, timedOut, tail, ...(tailError ? { tailError } : {}),
    })
  }

  return [
    tool<BuildInput>("mux_run_build", "运行构建或测试；返回退出状态与日志，保留 pane 供人工查看或重试。",
      schema({ name, command, cwd, wait: bool("是否等待命令退出；默认 true。"), timeoutMs, tailLines }, ["name", "command"]),
      async ({ cwd, timeoutMs, tailLines, ...input }, context) => {
        const result = await manager.runBuild({
          ...input, cwd: workingDirectory(cwd), ...origin(context),
          timeoutMs: timeoutMs ?? defaults.defaultTimeoutMs,
          tailLines: tailLines ?? defaults.defaultTailLines,
        })
        const info = await attach(result.task)
        return report([
          taskText(info),
          `exitCode=${info.exitCode ?? "未取得"} timedOut=${result.timedOut}`,
          result.timedOut && "等待构建超时；pane 不会被终止，可人工附加查看或重试。",
          result.tail && `日志尾部：\n${result.tail}`,
        ].filter(Boolean).join("\n"), { ...info, ok: result.ok, timedOut: result.timedOut, tail: result.tail })
      }),
    tool<ServiceInput>("mux_service", "启动、重启、停止、查询或移除项目后台服务。",
      schema({
        action: choices(ACTIONS, "服务操作；remove 会移除 pane 和任务记录。"), name, command, cwd,
        restartIfRunning: bool("start 时若已运行，是否重启；默认 false。"),
        force: bool("stop 等待超时后是否强制关闭 pane；默认 false。"), timeoutMs, tailLines,
      }, ["action", "name"]),
      async ({ action, cwd, timeoutMs, tailLines, ...input }, context) => {
        const result = await manager.serviceAction({
          ...input, action, cwd: workingDirectory(cwd), ...origin(context),
          timeoutMs: timeoutMs ?? defaults.defaultTimeoutMs,
        })
        return actionReport(`服务 ${action}`, result, tailLines ?? defaults.defaultTailLines ?? 30, action === "remove" && result.ok)
      }),
    tool<Selector & { command?: string; tailLines?: number }>("mux_restart", "按 ID 或无歧义的名称重启已有构建或服务，可替换命令。",
      schema({ ...selector, command, tailLines }),
      async ({ command, tailLines, ...selector }, context) => {
        const found = await resolveTask(selector)
        if (found.error) return found.error
        const result = await manager.restartTask(found.task.id, { command, ...origin(context) })
        return actionReport("重启任务", result, tailLines ?? defaults.defaultTailLines ?? 30)
      }),
    tool<Selector & { lines?: number }>("mux_logs", "按 ID 或无歧义的名称抓取任务日志。",
      schema({ ...selector, lines: integer("返回最近的日志行数；默认 100。") }),
      async ({ lines = 100, ...selector }) => {
        const found = await resolveTask(selector)
        if (found.error) return found.error
        const logs = await manager.captureLogs(found.task.id, lines)
        const info = await attach(found.task)
        return report(`${taskText(info)}\n日志：\n${logs}`, { ...info, ok: true, logs })
      }),
    tool<Selector & { input: string; enter?: boolean }>("mux_input", "向仍活着的终端 pane 发送字面文本，包括任务退出后驻留的 shell。设 enter: false 可由 AI 输入，人在终端确认后手动按回车。",
      schema({ ...selector, input: str("发送的文本。可为空，仅发送回车。"), enter: bool("是否发送回车；默认 true。") }, ["input"]),
      async ({ input, enter = true, ...selector }) => {
        const found = await resolveTask(selector)
        if (found.error) return found.error
        await manager.sendInput(found.task.id, input, { enter })
        return report(`已向任务 ${found.task.id} 发送输入（enter=${enter}）。`,
          { ...taskSummary(found.task), ok: true, enter })
      }),
    tool<Selector & { session?: boolean }>("mux_remove", "移除单个构建或服务任务，关闭其 pane 并删除记录。危险：session: true 会关闭 cwd 对应的整个 mux 会话，终止会话中的所有任务并使已附加的终端脱离。",
      schema({ ...selector, session: bool("关闭整个项目会话；仅使用 cwd 定位，省略 cwd 时使用当前项目。") }),
      async ({ session, ...selector }) => {
        if (session) {
          const result = await manager.closeSession({ cwd: workingDirectory(selector.cwd) })
          return report(`已关闭会话 ${result.sessionName}，清理 ${result.removed} 条任务记录。`, result)
        }
        const found = await resolveTask(selector)
        if (found.error) return found.error
        const { ok, task } = await manager.removeTask(found.task.id)
        if (!ok || !task) return report(`未找到任务 ${found.task.id}。`, { ok: false, error: "task_not_found" })
        return report(`已移除任务 ${task.id}。`, { ...taskSummary(task), ok, status: "removed" })
      }),
    tool<ListInput>("mux_list", "列出受管任务，默认仅当前项目；可清理已丢失 pane 的记录。",
      schema({
        cwd, all: bool("未指定 cwd 时，是否查看所有项目。"), role, status: choices(STATUSES, "筛选任务状态。"),
        pruneGone: bool("先清理目录和角色范围内的 gone 记录，不受 status 筛选影响。"),
      }),
      async ({ cwd, all, role, status, pruneGone }) => {
        const filter: TaskFilter = {
          cwd: cwd === undefined && all ? undefined : workingDirectory(cwd), role,
        }
        const pruned = pruneGone ? await manager.pruneGone(filter) : []
        const tasks = await Promise.all((await manager.listTasks({ ...filter, status })).map(attach))
        return report([
          `任务范围：${filter.cwd ?? "所有项目"}；共 ${tasks.length} 个任务${pruneGone ? `，清理 ${pruned.length} 条记录` : ""}。`,
          ...tasks.map(taskText),
        ].join("\n"), { ok: true, cwd: filter.cwd ?? null, total: tasks.length, tasks, pruned: pruned.map(taskSummary) })
      }),
    tool<HistoryInput>("mux_clean_history", "预览或确认清理指定项目的受管任务历史。仅在显式传入预览返回的候选项时才清理；不关闭整个会话。",
      schema({
        cwd,
        includeShell: bool("是否允许清理已过保留期但仍有驻留 shell 的任务；默认 false。"),
        retentionDays: integer("保留已结束任务的天数；默认 7。已丢失 pane 的记录不受保留期限制。"),
        candidates: {
          type: "array",
          description: "省略则仅预览。确认时传入已审核的候选项，沿用预览的 cwd、includeShell 和 retentionDays。",
          items: schema({
            id: str("预览中的任务 ID。"),
            updatedAt: str("预览中的任务更新时间，原样回传。"),
            restartCount: integer("预览中的任务重启次数，原样回传。"),
          }, ["id", "updatedAt", "restartCount"]),
        },
      }),
      async ({ cwd, includeShell, retentionDays, candidates }) => {
        const options = { cwd: workingDirectory(cwd), includeShell, retentionDays }
        if (candidates !== undefined) {
          const result = await manager.cleanHistory({ ...options, candidates })
          return report([
            `任务范围：${options.cwd}；已清理 ${result.removed.length} 项，跳过 ${result.skipped.length} 项，失败 ${result.failed.length} 项。`,
            ...result.skipped.map((id) => `跳过 ${id}`),
            ...result.failed.map(({ id, message }) => `失败 ${id}：${message}`),
          ].join("\n"), { ok: result.failed.length === 0, cwd: options.cwd, ...result })
        }
        const tasks = (await manager.previewHistory(options)).map((task) => ({ ...taskSummary(task), updatedAt: task.updatedAt }))
        const preview = tasks.map(({ id, updatedAt, restartCount }) => ({ id, updatedAt, restartCount }))
        return report([
          `任务范围：${options.cwd}；预览 ${tasks.length} 项，未执行清理。`,
          ...tasks.map((task, index) =>
            `[${task.status}] ${task.role} ${task.name}${task.shell ? "（含驻留 shell）" : ""} ${JSON.stringify(preview[index])}`),
          "确认清理时，传入已审核的 candidates 并沿用本次选项。",
        ].join("\n"), { ok: true, cwd: options.cwd, tasks, candidates: preview })
      }),
  ]
}
