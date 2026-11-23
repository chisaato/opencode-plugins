import type { HistoryCandidate, ManagedTask } from "@misakacloud/opencode-mux-core"
import type { HistoryCleanResponse } from "../types"
import { formatClientError, HistoryCleanPartialError, type MuxClient } from "./client"
import { sortTasks } from "./tasks"

export interface HistoryDialogState {
  dialogId: number
  targetCwd: string
  includeShell: boolean
  previewSeq: number
  previewLoading: boolean
  previewTasks: ManagedTask[]
  previewError: string
  cleaning: boolean
  cleanError: string
  cleanResult: HistoryCleanResponse | null
  previewNameById: Map<string, string>
}

export interface HistoryDialogControllerOptions {
  client: Pick<MuxClient, "previewHistory" | "cleanHistory">
  getCurrentDirectory: () => string | null
  onChange: () => void
  onRemoved: (removedIds: readonly string[]) => void
  onNotify: (kind: "info" | "success" | "error", message: string) => void
  onRefresh: () => void
}

export interface HistoryDialogController {
  getState: () => HistoryDialogState | null
  open: () => boolean
  close: () => boolean
  setIncludeShell: (checked: boolean) => void
  retryPreview: () => void
  confirm: () => Promise<void>
  onDirectoryChange: (nextDirectory: string | null) => void
}

/**
 * 历史清理弹窗状态机：
 * - 绑定目标项目目录与预览快照，避免无 cwd 或切项目后触发全局/跨项目清理
 * - 通过序号屏蔽过期预览响应，防止并发切换勾选框导致状态回滚
 * - 支持全量成功、部分跳过/失败与分批中断结果的清晰反馈
 */
export function createHistoryDialogController(options: HistoryDialogControllerOptions): HistoryDialogController {
  let state: HistoryDialogState | null = null
  let nextDialogId = 0

  async function loadPreview(): Promise<void> {
    const current = state
    if (!current) return
    const dialogId = current.dialogId
    const seq = ++current.previewSeq
    const { targetCwd, includeShell } = current
    current.previewLoading = true
    current.previewError = ""
    current.cleanError = ""
    current.cleanResult = null
    options.onChange()

    try {
      const res = await options.client.previewHistory({ cwd: targetCwd, includeShell })
      if (
        !state
        || state.dialogId !== dialogId
        || state.previewSeq !== seq
        || options.getCurrentDirectory() !== targetCwd
      ) {
        return
      }
      const sorted = sortTasks(res.tasks)
      state.previewTasks = sorted
      state.previewNameById = new Map(sorted.map((task) => [task.id, task.name]))
      state.previewLoading = false
      options.onChange()
    } catch (error) {
      if (
        !state
        || state.dialogId !== dialogId
        || state.previewSeq !== seq
        || options.getCurrentDirectory() !== targetCwd
      ) {
        return
      }
      state.previewTasks = []
      state.previewError = formatClientError(error).detail
      state.previewLoading = false
      options.onChange()
    }
  }

  return {
    getState: () => state,

    open: () => {
      const cwd = options.getCurrentDirectory()
      if (!cwd || !cwd.trim()) return false
      state = {
        dialogId: ++nextDialogId,
        targetCwd: cwd,
        includeShell: false,
        previewSeq: 0,
        previewLoading: true,
        previewTasks: [],
        previewError: "",
        cleaning: false,
        cleanError: "",
        cleanResult: null,
        previewNameById: new Map(),
      }
      void loadPreview()
      return true
    },

    close: () => {
      if (!state || state.cleaning) return false
      state = null
      options.onChange()
      return true
    },

    setIncludeShell: (checked) => {
      if (!state || state.cleaning || state.includeShell === checked) return
      state.includeShell = checked
      // 立即清空旧候选，防止在重新扫描完成前误确认旧集合。
      state.previewTasks = []
      state.previewError = ""
      state.cleanError = ""
      state.cleanResult = null
      void loadPreview()
    },

    retryPreview: () => {
      if (!state || state.cleaning) return
      if (options.getCurrentDirectory() !== state.targetCwd) {
        state = null
        options.onChange()
        return
      }
      void loadPreview()
    },

    confirm: async () => {
      const current = state
      if (!current || current.cleaning || current.previewLoading || current.previewError || current.cleanResult !== null) {
        return
      }
      if (options.getCurrentDirectory() !== current.targetCwd || !current.targetCwd.trim()) {
        state = null
        options.onChange()
        return
      }
      if (current.previewTasks.length === 0) return

      const { dialogId, targetCwd, includeShell } = current
      const candidates: HistoryCandidate[] = current.previewTasks.map((task) => ({
        id: task.id,
        updatedAt: task.updatedAt,
        restartCount: task.restartCount,
      }))

      current.cleaning = true
      current.cleanError = ""
      current.cleanResult = null
      options.onChange()

      try {
        const res = await options.client.cleanHistory({
          cwd: targetCwd,
          includeShell,
          candidates,
        })
        if (res.removed.length > 0) {
          options.onRemoved(res.removed)
        }

        const stillSameProject = options.getCurrentDirectory() === targetCwd
        const stillSameDialog = state?.dialogId === dialogId
        if (!stillSameProject || !stillSameDialog) {
          if (stillSameDialog) {
            state = null
            options.onChange()
          }
          if (res.removed.length > 0) {
            options.onNotify("success", `已清理 ${res.removed.length} 条历史记录`)
          }
          return
        }

        if (res.skipped.length === 0 && res.failed.length === 0) {
          state = null
          options.onChange()
          options.onNotify("success", `已清理 ${res.removed.length} 条历史记录`)
        } else {
          current.cleaning = false
          current.cleanResult = res
          options.onChange()
          if (res.failed.length > 0) {
            options.onNotify("error", `清理部分完成：已清理 ${res.removed.length} 项，失败 ${res.failed.length} 项`)
          } else {
            options.onNotify("info", `已清理 ${res.removed.length} 项，跳过 ${res.skipped.length} 项`)
          }
        }
      } catch (error) {
        const partial = error instanceof HistoryCleanPartialError ? error.partial : undefined
        if (partial && partial.removed.length > 0) {
          options.onRemoved(partial.removed)
        }
        const detail = formatClientError(error).detail
        if (state?.dialogId === dialogId) {
          if (options.getCurrentDirectory() !== targetCwd) {
            state = null
          } else {
            current.cleaning = false
            current.cleanResult = partial ?? null
            current.cleanError = detail
          }
          options.onChange()
        }
        options.onNotify("error", `清理历史失败：${detail}`)
      } finally {
        options.onRefresh()
      }
    },

    onDirectoryChange: (nextDirectory) => {
      if (!state) return
      if (nextDirectory === state.targetCwd) return
      if (!state.cleaning) {
        state = null
        options.onChange()
      }
    },
  }
}
