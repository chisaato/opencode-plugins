import { connectHost, type HostReadyContext } from "@openchamber/sdk"
import {
  applyHostReady,
  GUEST_UI_LOOK_CSS,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSpinner,
  type BannerHandle,
  type ButtonHandle,
  type EmptyHandle,
} from "@openchamber/sdk/ui"
import type { MuxBackend } from "@misakacloud/opencode-mux-core"
import type { TaskView } from "../src/types"
import { copyTextWithToast, createMuxClient, formatClientError, type FormattedError } from "../src/ui/client"
import { createLogViewport, type LogViewport } from "../src/ui/log-viewer"
import { createPoller } from "../src/ui/poller"
import { injectStyle, MUX_SHARED_CSS } from "../src/ui/styles"
import { isAttachable, roleLabel, sortTasks, statusMeta, summarizeTasks } from "../src/ui/tasks"

const STATUS_CSS = `
${MUX_SHARED_CSS}

.mux-status-app {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0 4px;
  min-width: 0;
}

.mux-status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.mux-status-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.mux-status-backend {
  font-size: 0.7rem;
  color: var(--oc-muted, inherit);
}

.mux-status-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.mux-status-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mux-status-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 60%, transparent);
  background: color-mix(in srgb, var(--oc-elevated, transparent) 72%, transparent);
  transition: border-color 140ms ease, background 140ms ease;
}

.mux-status-row[data-status="running"] {
  border-left: 2.5px solid var(--oc-info, #3b82f6);
}

.mux-status-row[data-status="failed"] {
  border-left: 2.5px solid var(--oc-error, #ef4444);
  background: color-mix(in srgb, var(--oc-error, #ef4444) 5%, var(--oc-elevated, transparent));
}

.mux-status-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.mux-status-row-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.mux-status-name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-status-row-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.mux-status-cmd {
  font-size: 0.72rem;
  color: var(--oc-muted, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-status-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.mux-status-drawer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 45%, transparent);
}

.mux-status-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.mux-status-drawer-label {
  font-size: 0.7rem;
  color: var(--oc-muted, inherit);
}

.mux-status-drawer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mux-status-stdin {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mux-status-stdin-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: calc(var(--oc-radius, 9px) - 3px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 70%, transparent);
  background: var(--oc-bg, transparent);
  color: var(--oc-fg, inherit);
  font-family: var(--oc-mono, var(--font-mono, monospace));
  font-size: 0.75rem;
  outline: none;
}

.mux-status-stdin-input:focus {
  border-color: var(--oc-primary, currentColor);
}
`

const LOG_LINES = 80
const MIN_HEIGHT = 24
const MAX_HEIGHT = 480

interface RowController {
  element: HTMLElement
  update: (task: TaskView) => void
  dispose: () => void
}

const host = connectHost()
const client = createMuxClient(host)
const root = document.getElementById("root")

if (root) {
  injectStyle("oc-look", GUEST_UI_LOOK_CSS)
  injectStyle("mux-status", STATUS_CSS)

  const app = document.createElement("div")
  app.className = "oc-sdk mux-status-app"
  root.append(app)

  // 顶部状态概览栏
  const header = document.createElement("div")
  header.className = "mux-status-header"
  const summaryEl = document.createElement("div")
  summaryEl.className = "mux-status-summary"
  const headerActionsEl = document.createElement("div")
  headerActionsEl.className = "mux-status-header-actions"
  header.append(summaryEl, headerActionsEl)

  const bannerSlot = document.createElement("div")
  const loadingSlot = document.createElement("div")
  const emptySlot = document.createElement("div")
  const listEl = document.createElement("div")
  listEl.className = "mux-status-list"

  app.append(header, bannerSlot, loadingSlot, emptySlot, listEl)

  const spinner = mountSpinner(loadingSlot, { size: "sm", label: "正在加载任务..." })

  let pruneBtn: ButtonHandle | null = null
  const refreshBtn = mountButton(headerActionsEl, {
    label: "刷新",
    variant: "ghost",
    size: "xs",
    onClick: () => {
      void poller.triggerNow()
    },
  })

  let bannerHandle: BannerHandle | null = null
  let emptyHandle: EmptyHandle | null = null

  // 应用状态
  let currentDirectory: string | null = null
  let backend: MuxBackend | null | undefined = undefined
  let tasks: TaskView[] = []
  let initialLoading = true
  let refreshing = false
  let lastError: FormattedError | null = null
  let expandedLogTaskId: string | null = null
  let logLoadingId: string | null = null
  let logTextById = new Map<string, string>()
  let logErrorById = new Map<string, string>()
  const stdinDrafts = new Map<string, string>()
  const busyActions = new Set<string>()
  const stopTimedOutIds = new Set<string>()
  const rowControllers = new Map<string, RowController>()

  // 精确同步 Work Status 高度（24..480px）
  let lastSentHeight = 0
  let heightRaf = 0
  const syncHeight = () => {
    if (heightRaf) cancelAnimationFrame(heightRaf)
    heightRaf = requestAnimationFrame(() => {
      heightRaf = 0
      const measured = Math.ceil(app.getBoundingClientRect().height)
      const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, measured))
      if (Math.abs(clamped - lastSentHeight) >= 1) {
        lastSentHeight = clamped
        void host.setHeight(clamped).catch(() => {})
      }
    })
  }

  const resizeObserver = new ResizeObserver(() => {
    syncHeight()
  })
  resizeObserver.observe(app)

  function showToast(kind: "info" | "success" | "error", message: string): void {
    void host.toast({ kind, message }).catch(() => {})
  }

  function setBanner(props: Parameters<typeof mountBanner>[1] | null): void {
    if (!props) {
      bannerHandle?.dispose()
      bannerHandle = null
      bannerSlot.hidden = true
      return
    }
    bannerSlot.hidden = false
    if (!bannerHandle) {
      bannerHandle = mountBanner(bannerSlot, props)
    } else {
      bannerHandle.update(props)
    }
  }

  function setEmpty(props: Parameters<typeof mountEmpty>[1] | null): void {
    if (!props) {
      emptyHandle?.dispose()
      emptyHandle = null
      emptySlot.hidden = true
      return
    }
    emptySlot.hidden = false
    if (!emptyHandle) {
      emptyHandle = mountEmpty(emptySlot, props)
    } else {
      emptyHandle.update(props)
    }
  }

  async function fetchLogsForExpanded(taskId: string): Promise<void> {
    logLoadingId = taskId
    try {
      const res = await client.getLogs(taskId, LOG_LINES)
      logTextById.set(taskId, res.tail)
      logErrorById.delete(taskId)
    } catch (error) {
      const formatted = formatClientError(error)
      logErrorById.set(taskId, formatted.detail)
    } finally {
      if (logLoadingId === taskId) logLoadingId = null
      render()
    }
  }

  async function runTaskAction(actionKey: string, work: () => Promise<void>): Promise<void> {
    if (busyActions.has(actionKey)) return
    busyActions.add(actionKey)
    render()
    try {
      await work()
    } catch (error) {
      const formatted = formatClientError(error)
      showToast("error", formatted.detail)
    } finally {
      busyActions.delete(actionKey)
      await poller.triggerNow()
    }
  }

  function createRowController(initialTask: TaskView): RowController {
    let task = initialTask

    const row = document.createElement("div")
    row.className = "mux-status-row"

    const top = document.createElement("div")
    top.className = "mux-status-row-top"

    const titleWrap = document.createElement("div")
    titleWrap.className = "mux-status-row-title"
    const dot = document.createElement("span")
    dot.className = "mux-dot"
    const nameEl = document.createElement("span")
    nameEl.className = "mux-status-name"
    titleWrap.append(dot, nameEl)

    const badgesWrap = document.createElement("div")
    badgesWrap.className = "mux-status-row-badges"
    const rolePill = document.createElement("span")
    rolePill.className = "mux-pill"
    const statusPill = document.createElement("span")
    statusPill.className = "mux-pill"
    const exitPill = document.createElement("span")
    exitPill.className = "mux-pill mux-mono mux-num"
    const restartPill = document.createElement("span")
    restartPill.className = "mux-pill mux-num"
    badgesWrap.append(rolePill, statusPill, exitPill, restartPill)

    top.append(titleWrap, badgesWrap)

    const cmdEl = document.createElement("div")
    cmdEl.className = "mux-status-cmd mux-mono"

    const actionsEl = document.createElement("div")
    actionsEl.className = "mux-status-actions"

    const primaryBtn = mountButton(actionsEl, {
      label: "重试",
      variant: "outline",
      size: "xs",
      onClick: () => {
        if (task.status === "running" && task.role === "service") {
          void runTaskAction(`${task.id}:restart`, async () => {
            stopTimedOutIds.delete(task.id)
            await client.restartTask(task.id)
            showToast("success", `已重启服务 ${task.name}`)
          })
        } else {
          void runTaskAction(`${task.id}:restart`, async () => {
            stopTimedOutIds.delete(task.id)
            await client.restartTask(task.id)
            showToast("success", task.role === "build" ? `已重新运行 ${task.name}` : `已启动 ${task.name}`)
          })
        }
      },
    })

    const stopBtn = mountButton(actionsEl, {
      label: "停止",
      variant: "outline",
      size: "xs",
      onClick: () => {
        void runTaskAction(`${task.id}:stop`, async () => {
          const res = await client.stopTask(task.id, { force: false })
          if (res.timedOut) {
            stopTimedOutIds.add(task.id)
            showToast("info", `${task.name} 未响应 Ctrl+C，可点击「强停」立即终止`)
          } else {
            stopTimedOutIds.delete(task.id)
            showToast("success", `已停止 ${task.name}`)
          }
        })
      },
    })

    const forceStopBtn = mountButton(actionsEl, {
      label: "强停",
      variant: "destructive",
      size: "xs",
      onClick: () => {
        void runTaskAction(`${task.id}:force`, async () => {
          await client.stopTask(task.id, { force: true })
          stopTimedOutIds.delete(task.id)
          showToast("success", `已强制停止 ${task.name}`)
        })
      },
    })

    const logBtn = mountButton(actionsEl, {
      label: "日志",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        if (expandedLogTaskId === task.id) {
          expandedLogTaskId = null
          render()
        } else {
          expandedLogTaskId = task.id
          logViewport.resetPin()
          render()
          void fetchLogsForExpanded(task.id)
        }
      },
    })

    const attachBtn = mountButton(actionsEl, {
      label: "Attach",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        void copyTextWithToast(host, task.attachCommand, `已复制: ${task.attachCommand}`)
      },
    })

    // 内联可折叠日志抽屉
    const drawerEl = document.createElement("div")
    drawerEl.className = "mux-status-drawer"
    drawerEl.hidden = true

    const drawerHead = document.createElement("div")
    drawerHead.className = "mux-status-drawer-head"
    const drawerLabel = document.createElement("span")
    drawerLabel.className = "mux-status-drawer-label"
    drawerLabel.textContent = `最近 ${LOG_LINES} 行输出`

    const drawerTools = document.createElement("div")
    drawerTools.className = "mux-status-drawer-tools"
    const refreshLogsBtn = mountButton(drawerTools, {
      label: "刷新",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        void fetchLogsForExpanded(task.id)
      },
    })
    const drawerForceBtn = mountButton(drawerTools, {
      label: "强停",
      variant: "destructive",
      size: "xs",
      onClick: () => {
        void runTaskAction(`${task.id}:force`, async () => {
          await client.stopTask(task.id, { force: true })
          stopTimedOutIds.delete(task.id)
          showToast("success", `已强制停止 ${task.name}`)
        })
      },
    })
    const collapseBtn = mountButton(drawerTools, {
      label: "收起",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        expandedLogTaskId = null
        render()
      },
    })
    drawerHead.append(drawerLabel, drawerTools)

    const logViewport: LogViewport = createLogViewport({ compact: true })

    // 运行中任务的快捷 stdin 输入行
    const stdinForm = document.createElement("form")
    stdinForm.className = "mux-status-stdin"
    const stdinInput = document.createElement("input")
    stdinInput.type = "text"
    stdinInput.className = "mux-status-stdin-input"
    stdinInput.placeholder = "向终端发送输入（如 y、rs、回车）..."
    stdinInput.value = stdinDrafts.get(task.id) ?? ""
    stdinInput.addEventListener("input", () => {
      stdinDrafts.set(task.id, stdinInput.value)
    })

    const sendStdin = () => {
      const value = stdinInput.value
      void runTaskAction(`${task.id}:input`, async () => {
        await client.sendInput(task.id, { input: value, enter: true })
        stdinDrafts.set(task.id, "")
        if (document.activeElement === stdinInput || stdinInput.value === value) {
          stdinInput.value = ""
        }
        await fetchLogsForExpanded(task.id)
      })
    }

    const sendBtn = mountButton(stdinForm, {
      label: "发送",
      variant: "secondary",
      size: "xs",
      onClick: sendStdin,
    })
    stdinForm.addEventListener("submit", (event) => {
      event.preventDefault()
      sendStdin()
    })
    stdinForm.prepend(stdinInput)

    drawerEl.append(drawerHead, logViewport.element, stdinForm)
    row.append(top, cmdEl, actionsEl, drawerEl)

    // 保留各按钮包裹节点引用以便精确隐藏
    const actionNodes = Array.from(actionsEl.children) as HTMLElement[]
    const [primaryNode, stopNode, forceNode, logNode, attachNode] = actionNodes
    const drawerToolNodes = Array.from(drawerTools.children) as HTMLElement[]
    const drawerForceNode = drawerToolNodes[1]

    function update(nextTask: TaskView): void {
      task = nextTask
      const meta = statusMeta(task.status)
      const isRunning = task.status === "running"
      const attachable = isAttachable(task)
      const isExpanded = expandedLogTaskId === task.id

      row.dataset.status = task.status
      dot.dataset.status = task.status
      nameEl.textContent = task.name
      nameEl.title = task.name

      rolePill.textContent = roleLabel(task.role)
      statusPill.textContent = meta.label
      statusPill.dataset.tone = meta.tone

      if (task.exitCode !== undefined && !isRunning) {
        exitPill.hidden = false
        exitPill.textContent = `exit ${task.exitCode}`
        exitPill.dataset.tone = task.exitCode === 0 ? "success" : "error"
      } else {
        exitPill.hidden = true
      }

      if (task.restartCount > 0) {
        restartPill.hidden = false
        restartPill.textContent = `×${task.restartCount}`
      } else {
        restartPill.hidden = true
      }

      cmdEl.textContent = `$ ${task.command}`
      cmdEl.title = task.command

      // 操作按钮按角色与状态精确展示
      const anyBusy =
        busyActions.has(`${task.id}:restart`)
        || busyActions.has(`${task.id}:stop`)
        || busyActions.has(`${task.id}:force`)

      if (isRunning) {
        if (task.role === "service") {
          primaryNode.hidden = false
          primaryBtn.update({
            label: "重启",
            variant: "outline",
            loading: busyActions.has(`${task.id}:restart`),
            disabled: anyBusy,
          })
        } else {
          primaryNode.hidden = true
        }
        stopNode.hidden = false
        stopBtn.update({
          label: "停止",
          loading: busyActions.has(`${task.id}:stop`),
          disabled: anyBusy,
        })
        const showForce = stopTimedOutIds.has(task.id)
        forceNode.hidden = !showForce
        forceStopBtn.update({
          loading: busyActions.has(`${task.id}:force`),
          disabled: anyBusy,
        })
      } else {
        primaryNode.hidden = false
        primaryBtn.update({
          label: task.role === "build" ? "重试" : "启动",
          variant: task.status === "failed" ? "default" : "outline",
          loading: busyActions.has(`${task.id}:restart`),
          disabled: anyBusy,
        })
        stopNode.hidden = true
        forceNode.hidden = true
      }

      logNode.hidden = !attachable && !isExpanded
      logBtn.update({
        label: isExpanded ? "收起日志" : "日志",
        variant: isExpanded ? "secondary" : "ghost",
      })

      attachNode.hidden = !attachable
      if (attachable) {
        attachNode.title = `复制命令: ${task.attachCommand}`
      }

      // 抽屉展示与输入草稿保持
      drawerEl.hidden = !isExpanded
      if (isExpanded) {
        drawerForceNode.hidden = !isRunning
        drawerForceBtn.update({
          loading: busyActions.has(`${task.id}:force`),
          disabled: anyBusy,
        })
        refreshLogsBtn.update({ loading: logLoadingId === task.id })

        const logErr = logErrorById.get(task.id)
        const logText = logTextById.get(task.id) ?? ""
        if (logErr) {
          logViewport.setContent("", { emptyText: logErr, isError: true })
        } else if (!attachable) {
          logViewport.setContent("", { emptyText: "终端窗格已销毁，点击「重试/启动」可重新拉起" })
        } else {
          logViewport.setContent(logText, {
            emptyText: logLoadingId === task.id ? "正在获取输出..." : "暂无输出内容",
          })
        }

        stdinForm.hidden = !isRunning
        const draft = stdinDrafts.get(task.id) ?? ""
        if (document.activeElement !== stdinInput && stdinInput.value !== draft) {
          stdinInput.value = draft
        }
        sendBtn.update({
          loading: busyActions.has(`${task.id}:input`),
          disabled: !isRunning,
        })
      }
    }

    update(initialTask)

    return {
      element: row,
      update,
      dispose: () => {
        primaryBtn.dispose()
        stopBtn.dispose()
        forceStopBtn.dispose()
        logBtn.dispose()
        attachBtn.dispose()
        refreshLogsBtn.dispose()
        drawerForceBtn.dispose()
        collapseBtn.dispose()
        sendBtn.dispose()
        logViewport.dispose()
        row.remove()
      },
    }
  }

  function renderSummary(sorted: TaskView[]): void {
    summaryEl.textContent = ""
    const counts = summarizeTasks(sorted)

    if (counts.running > 0) {
      const pill = document.createElement("span")
      pill.className = "mux-pill mux-num"
      pill.dataset.tone = "info"
      const dot = document.createElement("span")
      dot.className = "mux-dot"
      dot.dataset.status = "running"
      pill.append(dot, `${counts.running} 运行中`)
      summaryEl.append(pill)
    }

    if (counts.failed > 0) {
      const pill = document.createElement("span")
      pill.className = "mux-pill mux-num"
      pill.dataset.tone = "error"
      pill.textContent = `${counts.failed} 失败`
      summaryEl.append(pill)
    }

    if (counts.running === 0 && counts.failed === 0 && counts.total > 0) {
      const pill = document.createElement("span")
      pill.className = "mux-pill mux-num"
      pill.textContent = `${counts.total} 个任务`
      summaryEl.append(pill)
    }

    const backendSpan = document.createElement("span")
    backendSpan.className = "mux-status-backend mux-mono"
    if (backend === undefined) {
      backendSpan.textContent = currentDirectory ? "检查中" : ""
    } else if (backend === null) {
      backendSpan.textContent = "未检测到复用器"
    } else {
      backendSpan.textContent = backend.kind
    }
    if (backendSpan.textContent) summaryEl.append(backendSpan)

    // 存在已失效任务时提供一键清理入口
    if (counts.gone > 0 && currentDirectory) {
      if (!pruneBtn) {
        pruneBtn = mountButton(headerActionsEl, {
          label: `清理失效 (${counts.gone})`,
          variant: "ghost",
          size: "xs",
          onClick: () => {
            const targetDir = currentDirectory
            if (!targetDir) return
            void runTaskAction("prune", async () => {
              const res = await client.prune({ cwd: targetDir })
              showToast("success", `已清理 ${res.pruned.length} 条已失效任务`)
            })
          },
        })
        // 保持清理按钮在刷新按钮左侧
        headerActionsEl.prepend(headerActionsEl.lastElementChild!)
      } else {
        pruneBtn.update({
          label: `清理失效 (${counts.gone})`,
          loading: busyActions.has("prune"),
        })
      }
    } else if (pruneBtn) {
      pruneBtn.dispose()
      pruneBtn = null
    }

    refreshBtn.update({ loading: refreshing })
  }

  function reconcileRows(sorted: TaskView[]): void {
    const activeIds = new Set(sorted.map((item) => item.id))
    for (const [id, ctrl] of rowControllers) {
      if (!activeIds.has(id)) {
        ctrl.dispose()
        rowControllers.delete(id)
        if (expandedLogTaskId === id) expandedLogTaskId = null
      }
    }

    for (let index = 0; index < sorted.length; index++) {
      const task = sorted[index]
      let ctrl = rowControllers.get(task.id)
      if (!ctrl) {
        ctrl = createRowController(task)
        rowControllers.set(task.id, ctrl)
      } else {
        ctrl.update(task)
      }
      const currentAtSlot = listEl.children[index]
      if (currentAtSlot !== ctrl.element) {
        listEl.insertBefore(ctrl.element, currentAtSlot ?? null)
      }
    }
  }

  function render(): void {
    const sorted = sortTasks(tasks)
    renderSummary(sorted)

    if (!currentDirectory) {
      loadingSlot.hidden = true
      listEl.hidden = true
      setBanner(null)
      setEmpty({
        title: "等待打开项目",
        body: "打开项目目录后，此处将显示当前项目的构建与后台服务任务。",
      })
      syncHeight()
      return
    }

    if (initialLoading && sorted.length === 0 && !lastError) {
      loadingSlot.hidden = false
      listEl.hidden = true
      setBanner(null)
      setEmpty(null)
      syncHeight()
      return
    }
    loadingSlot.hidden = true

    if (lastError) {
      setBanner({
        tone: lastError.setupRequired ? "warning" : "error",
        title: lastError.title,
        body: lastError.detail,
        action: {
          label: "重试",
          onClick: () => {
            void poller.triggerNow()
          },
        },
      })
    } else if (backend === null) {
      setBanner({
        tone: "warning",
        title: "未检测到 tmux 或 psmux",
        body: "请先在系统 PATH 中安装 tmux（Linux/macOS）或 psmux（Windows），再点击重试。",
        action: {
          label: "重新检测",
          onClick: () => {
            void poller.triggerNow()
          },
        },
      })
    } else {
      setBanner(null)
    }

    if (sorted.length === 0 && !lastError && backend !== null) {
      listEl.hidden = true
      setEmpty({
        title: "当前项目暂无 Mux 任务",
        body: "由 AI 或面板发起的构建与后台服务会在此实时显示。",
      })
    } else {
      setEmpty(null)
      listEl.hidden = sorted.length === 0
      reconcileRows(sorted)
    }

    syncHeight()
  }

  const poller = createPoller({
    getIntervalMs: () => {
      if (lastError?.setupRequired) return 6000
      const hasRunning = tasks.some((t) => t.status === "running")
      if (hasRunning || expandedLogTaskId !== null) return 1800
      return 4500
    },
    run: async ({ stale }) => {
      if (!currentDirectory) {
        tasks = []
        initialLoading = false
        refreshing = false
        render()
        return
      }
      refreshing = true
      render()
      try {
        const res = await client.listTasks({ cwd: currentDirectory })
        if (stale()) return
        backend = res.backend
        tasks = res.tasks
        lastError = null
        // 同步清理已停止任务的 timeout 标记
        for (const t of tasks) {
          if (t.status !== "running") stopTimedOutIds.delete(t.id)
        }
        // 若日志抽屉打开，同步拉取最新日志
        if (expandedLogTaskId) {
          const target = tasks.find((t) => t.id === expandedLogTaskId)
          if (target && isAttachable(target)) {
            try {
              const logs = await client.getLogs(target.id, LOG_LINES)
              if (stale()) return
              logTextById.set(target.id, logs.tail)
              logErrorById.delete(target.id)
            } catch (logError) {
              if (!stale()) {
                logErrorById.set(target.id, formatClientError(logError).detail)
              }
            }
          }
        }
      } catch (error) {
        if (!stale()) {
          lastError = formatClientError(error)
        }
      } finally {
        if (!stale()) {
          initialLoading = false
          refreshing = false
          render()
        }
      }
    },
  })

  function handleDirectoryChange(nextDirectory: string | null, shouldTrigger = true): void {
    const normalized = nextDirectory && nextDirectory.trim() ? nextDirectory : null
    if (normalized === currentDirectory) return
    currentDirectory = normalized
    expandedLogTaskId = null
    stopTimedOutIds.clear()
    logTextById.clear()
    logErrorById.clear()
    tasks = []
    initialLoading = Boolean(normalized)
    lastError = null
    render()
    if (shouldTrigger) void poller.triggerNow({ invalidate: true })
  }

  let started = false
  host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    handleDirectoryChange(ctx.directory, started)
    if (!started) {
      started = true
      poller.start()
    }
  })

  host.onDirectory((directory) => {
    handleDirectoryChange(directory)
  })

  window.addEventListener("beforeunload", () => {
    resizeObserver.disconnect()
    poller.dispose()
    spinner.dispose()
    refreshBtn.dispose()
    pruneBtn?.dispose()
    bannerHandle?.dispose()
    emptyHandle?.dispose()
    for (const ctrl of rowControllers.values()) ctrl.dispose()
    rowControllers.clear()
    host.dispose()
  })

  render()
}
