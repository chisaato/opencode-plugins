import type { ManagedTask, MuxBackend, TaskRole, TaskStatus, TriggerSource } from "@misakacloud/opencode-mux-core"
import type { Tone } from "@openchamber/sdk/ui"
import type { TaskView } from "../types"

export interface StatusPresentation {
  label: string
  shortLabel: string
  tone: Tone
  priority: number
}

const STATUS_MAP: Record<TaskStatus, StatusPresentation> = {
  running: { label: "运行中", shortLabel: "运行", tone: "info", priority: 0 },
  failed: { label: "已失败", shortLabel: "失败", tone: "error", priority: 1 },
  stopped: { label: "已停止", shortLabel: "停止", tone: "warning", priority: 2 },
  succeeded: { label: "已成功", shortLabel: "成功", tone: "success", priority: 3 },
  gone: { label: "已失效", shortLabel: "失效", tone: "neutral", priority: 4 },
}

export function statusMeta(status: TaskStatus): StatusPresentation {
  return STATUS_MAP[status] ?? STATUS_MAP.gone
}

export function roleLabel(role: TaskRole): string {
  return role === "build" ? "构建" : "服务"
}

export function sourceLabel(source?: TriggerSource): string {
  if (source === "ai") return "AI 触发"
  if (source === "openchamber") return "面板"
  if (source === "human") return "终端"
  return ""
}

export function backendLabel(backend: MuxBackend | null): string {
  if (!backend) return "未检测到复用器"
  return backend.kind
}

/** 按关注度排序：运行中与失败任务优先，再按更新时间倒序。 */
export function sortTasks<T extends Pick<ManagedTask, "status" | "updatedAt" | "name">>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const priorityDiff = statusMeta(a.status).priority - statusMeta(b.status).priority
    if (priorityDiff !== 0) return priorityDiff
    const timeDiff = b.updatedAt.localeCompare(a.updatedAt)
    if (timeDiff !== 0) return timeDiff
    return a.name.localeCompare(b.name)
  })
}

export interface TaskCounts {
  total: number
  running: number
  failed: number
  stopped: number
  succeeded: number
  gone: number
  builds: number
  services: number
}

export function summarizeTasks(tasks: readonly TaskView[]): TaskCounts {
  const counts: TaskCounts = {
    total: tasks.length,
    running: 0,
    failed: 0,
    stopped: 0,
    succeeded: 0,
    gone: 0,
    builds: 0,
    services: 0,
  }
  for (const task of tasks) {
    counts[task.status] += 1
    if (task.role === "build") counts.builds += 1
    else counts.services += 1
  }
  return counts
}

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return ""
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000))
  if (diffSec < 10) return "刚刚"
  if (diffSec < 60) return `${diffSec} 秒前`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay} 天前`
  return new Date(parsed).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

export function shortPath(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalized) return fullPath
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length <= 2) return normalized
  return `…/${parts.slice(-2).join("/")}`
}

export function isAttachable(task: TaskView): boolean {
  return task.status !== "gone" && !task.forceStopped && Boolean(task.attachCommand)
}
