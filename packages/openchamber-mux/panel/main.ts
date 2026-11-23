import { connectHost, type HostReadyContext } from "@openchamber/sdk"
import {
  applyHostReady,
  GUEST_UI_LOOK_CSS,
  mountBadge,
  mountBanner,
  mountButton,
  mountCheckbox,
  mountEmpty,
  mountSelect,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
  type BadgeHandle,
  type BannerHandle,
  type ButtonHandle,
  type CheckboxHandle,
  type EmptyHandle,
  type SelectHandle,
  type TabsHandle,
  type TextFieldHandle,
} from "@openchamber/sdk/ui"
import type { MuxBackend, TaskRole } from "@misakacloud/opencode-mux-core"
import type { TaskView } from "../src/types"
import {
  copyTextWithToast,
  createMuxClient,
  formatClientError,
  ServiceApiError,
  type FormattedError,
} from "../src/ui/client"
import { createLogViewport, type LogViewport } from "../src/ui/log-viewer"
import { createHistoryDialogController } from "../src/ui/history"
import { createPoller } from "../src/ui/poller"
import { injectStyle, MUX_SHARED_CSS } from "../src/ui/styles"
import {
  backendLabel,
  formatRelativeTime,
  isAttachable,
  roleLabel,
  shortPath,
  sortTasks,
  sourceLabel,
  statusMeta,
  summarizeTasks,
} from "../src/ui/tasks"

const PANEL_CSS = `
${MUX_SHARED_CSS}

.mux-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 12px;
  min-height: 100vh;
  min-width: 0;
}

@media (min-width: 680px) {
  .mux-panel {
    height: 100vh;
    overflow: hidden;
  }
}

.mux-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  flex: 0 0 auto;
}

.mux-panel-title-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.mux-panel-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--oc-fg, inherit);
}

.mux-panel-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

/* 新建任务抽屉卡片 */
.mux-launcher {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: var(--oc-radius, 9px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 75%, transparent);
  background: var(--oc-elevated, transparent);
  flex: 0 0 auto;
}

.mux-launcher-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.mux-launcher-hint {
  font-size: 0.75rem;
  color: var(--oc-muted, inherit);
}

.mux-launcher-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

@media (min-width: 560px) {
  .mux-launcher-grid {
    grid-template-columns: minmax(150px, 1fr) minmax(220px, 2fr);
  }
  .mux-launcher-cwd {
    grid-column: 1 / -1;
  }
}

.mux-launcher-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

/* 过滤与实时计数栏 */
.mux-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  flex: 0 0 auto;
}

.mux-summary-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* 主从工作区 */
.mux-workspace {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
}

@media (min-width: 680px) {
  .mux-workspace {
    grid-template-columns: minmax(280px, 39%) minmax(0, 1fr);
  }
}

.mux-list-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

@media (min-width: 680px) {
  .mux-list-pane {
    overflow-y: auto;
    padding-right: 2px;
  }
}

.mux-session-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--oc-radius, 9px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 58%, transparent);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 2.5%, transparent);
}

.mux-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 2px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 45%, transparent);
  min-width: 0;
}

.mux-group-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.mux-group-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mux-group-project {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-group-session {
  font-size: 0.6875rem;
  color: var(--oc-muted, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-group-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.mux-group-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mux-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 11px;
  border-radius: calc(var(--oc-radius, 9px) - 1px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  background: color-mix(in srgb, var(--oc-elevated, transparent) 75%, transparent);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.mux-card:hover {
  border-color: color-mix(in srgb, var(--oc-fg, currentColor) 28%, transparent);
  background: var(--oc-elevated, transparent);
}

.mux-card[data-selected="true"] {
  border-color: var(--oc-primary, currentColor);
  background: color-mix(in srgb, var(--oc-primary, #3b82f6) 7%, var(--oc-elevated, transparent));
  box-shadow: inset 2.5px 0 0 0 var(--oc-primary, currentColor);
}

.mux-card[data-status="failed"]:not([data-selected="true"]) {
  border-left: 2.5px solid var(--oc-error, #ef4444);
}

.mux-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.mux-card-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}

.mux-card-name {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-card-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.mux-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--oc-muted, inherit);
}

.mux-card-cmd {
  font-size: 0.75rem;
  color: var(--oc-muted, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 2px;
}

.mux-card-remove {
  margin-left: auto;
  color: var(--oc-muted, inherit);
  transition: opacity 140ms ease, color 140ms ease, background 140ms ease;
}

@media (hover: hover) {
  .mux-card-remove {
    opacity: 0.35;
  }
  .mux-card:hover .mux-card-remove,
  .mux-card:focus-within .mux-card-remove,
  .mux-card-remove:focus-visible {
    opacity: 1;
  }
}

.mux-card-remove:hover {
  color: var(--oc-error-text, var(--oc-error, #ef4444));
}

.mux-card-confirm,
.mux-insp-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 8px;
  border-radius: calc(var(--oc-radius, 9px) - 3px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 4%, transparent);
}

.mux-card-confirm[data-running="true"],
.mux-insp-confirm[data-running="true"] {
  border-color: color-mix(in srgb, var(--oc-error, #ef4444) 42%, transparent);
  background: color-mix(in srgb, var(--oc-error, #ef4444) 9%, transparent);
}

.mux-card-confirm-text,
.mux-insp-confirm-text {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--oc-fg, inherit);
}

.mux-insp-confirm-text {
  font-size: 0.78rem;
}

.mux-card-confirm[data-running="true"] .mux-card-confirm-text,
.mux-insp-confirm[data-running="true"] .mux-insp-confirm-text {
  color: var(--oc-error-text, var(--oc-error, #ef4444));
}

.mux-card-confirm-btns,
.mux-insp-confirm-btns {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* 右侧详情 / 实时终端检查器 */
.mux-inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--oc-radius, 9px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 70%, transparent);
  background: var(--oc-elevated, transparent);
  min-width: 0;
  min-height: 280px;
}

.mux-inspector-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.mux-inspector-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}

.mux-inspector-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mux-inspector-name {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
  word-break: break-word;
}

.mux-inspector-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.mux-inspector-cmd {
  padding: 6px 9px;
  border-radius: calc(var(--oc-radius, 9px) - 3px);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 4%, transparent);
  font-size: 0.75rem;
  color: var(--oc-fg, inherit);
  word-break: break-all;
}

.mux-meta-grid {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 0.74rem;
  color: var(--oc-muted, inherit);
}

.mux-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.mux-meta-value {
  color: var(--oc-fg, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-attach-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: calc(var(--oc-radius, 9px) - 3px);
  border: 1px dashed color-mix(in srgb, var(--oc-border, currentColor) 85%, transparent);
  background: transparent;
  color: var(--oc-fg, inherit);
  font-family: var(--oc-mono, var(--font-mono, monospace));
  font-size: 0.73rem;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}

.mux-attach-chip:hover {
  background: var(--oc-hover, transparent);
  border-color: var(--oc-primary, currentColor);
}

.mux-attach-chip-cmd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-attach-chip-tag {
  flex: 0 0 auto;
  color: var(--oc-primary-text, var(--oc-primary, inherit));
  font-family: var(--oc-font, var(--font-sans, sans-serif));
  font-size: 0.7rem;
  font-weight: 500;
}

.mux-log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 45%, transparent);
}

.mux-log-toolbar-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.mux-log-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mux-stdin-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.mux-stdin-input-wrap {
  flex: 1 1 200px;
  min-width: 0;
}

.mux-stdin-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding-bottom: 1px;
}

/* 关闭会话确认弹窗 */
.mux-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgb(0 0 0 / 0.45);
  backdrop-filter: blur(2px);
}

.mux-dialog {
  width: min(420px, 100%);
  max-height: 90dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--oc-sdk-float-edge, color-mix(in srgb, var(--oc-border, currentColor) 75%, transparent));
  background: var(--surface-elevated, var(--oc-elevated, var(--surface-background, var(--oc-bg, #1c1c1e))));
  color: var(--oc-elevated-fg, var(--oc-fg, inherit));
  box-shadow: var(--oc-sdk-float, 0 12px 32px rgb(0 0 0 / 0.28));
}

.mux-dialog--wide {
  width: min(480px, 100%);
}

.mux-dialog-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mux-dialog-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--oc-error-text, var(--oc-error, #ef4444));
}

.mux-dialog-title--neutral {
  color: var(--oc-fg, inherit);
}

.mux-dialog-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 0.75rem;
  color: var(--oc-muted, inherit);
}

.mux-dialog-body {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--oc-fg, inherit);
}

.mux-dialog-error {
  padding: 7px 10px;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px solid color-mix(in srgb, var(--oc-error, #ef4444) 40%, transparent);
  background: color-mix(in srgb, var(--oc-error, #ef4444) 10%, transparent);
  color: var(--oc-error-text, var(--oc-error, #ef4444));
  font-size: 0.78rem;
  line-height: 1.45;
}

.mux-dialog-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}

.mux-history-summary {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--oc-fg, inherit);
}

.mux-history-list {
  display: flex;
  flex-direction: column;
  max-height: min(240px, 38dvh);
  overflow-y: auto;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 2.5%, transparent);
}

.mux-history-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 45%, transparent);
}

.mux-history-item:last-child {
  border-bottom: 0;
}

.mux-history-row-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 6px;
  min-width: 0;
}

.mux-history-name {
  flex: 1 1 120px;
  min-width: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-history-time {
  flex: 0 0 auto;
  font-size: 0.7rem;
  color: var(--oc-muted, inherit);
  white-space: nowrap;
}

.mux-history-cmd {
  font-size: 0.72rem;
  color: var(--oc-muted, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mux-history-empty {
  padding: 16px 12px;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px dashed color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  font-size: 0.8rem;
  color: var(--oc-muted, inherit);
  text-align: center;
}

.mux-history-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 3%, transparent);
  font-size: 0.78rem;
}

.mux-history-result-counts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mux-history-result-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mux-history-result-label {
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--oc-fg, inherit);
}

.mux-history-result-items {
  margin: 0;
  padding-left: 16px;
  max-height: 120px;
  overflow-y: auto;
  font-size: 0.74rem;
  color: var(--oc-muted, inherit);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mux-history-result-items--error {
  color: var(--oc-error-text, var(--oc-error, #ef4444));
}
`

type ScopeMode = "project" | "all"
type RoleFilter = "all" | TaskRole

interface SessionGroup {
  muxSession: string
  cwd: string
  visibleTasks: TaskView[]
  totalCount: number
  runningCount: number
}

interface PendingCloseSession {
  muxSession: string
  cwd: string
  totalCount: number
  runningCount: number
}

interface CardController {
  element: HTMLElement
  update: (task: TaskView, selected: boolean) => void
  dispose: () => void
}

interface SessionGroupController {
  element: HTMLElement
  cardsContainer: HTMLElement
  update: (group: SessionGroup) => void
  dispose: () => void
}

const host = connectHost()
const client = createMuxClient(host)
const root = document.getElementById("root")

if (root) {
  injectStyle("oc-look", GUEST_UI_LOOK_CSS)
  injectStyle("mux-panel", PANEL_CSS)

  const app = document.createElement("div")
  app.className = "oc-sdk mux-panel"
  root.append(app)

  // --- 状态 ---
  let currentDirectory: string | null = null
  let scope: ScopeMode = "project"
  let roleFilter: RoleFilter = "all"
  let backend: MuxBackend | null | undefined = undefined
  let tasks: TaskView[] = []
  let selectedTaskId: string | null = null
  let initialLoading = true
  let refreshing = false
  let lastError: FormattedError | null = null

  let launcherOpen = false
  let launcherRole: TaskRole = "build"
  let draftName = ""
  let draftCommand = ""
  let draftCwd = ""
  let draftCwdTouched = false
  let launching = false

  let logLines = 200
  let autoRefreshLogs = true
  let logLoading = false
  let lastLogText = ""
  let lastLogError = ""
  let lastLogTaskId: string | null = null

  const stdinDrafts = new Map<string, string>()
  let stdinEnter = true
  const busyActions = new Set<string>()
  const stopTimedOutIds = new Set<string>()
  let confirmRemoveTaskId: string | null = null
  let inspConfirmRemoveTaskId: string | null = null
  let pendingCloseSession: PendingCloseSession | null = null
  let closeDialogError = ""
  const groupControllers = new Map<string, SessionGroupController>()
  const cardControllers = new Map<string, CardController>()

  function showToast(kind: "info" | "success" | "error", message: string): void {
    void host.toast({ kind, message }).catch(() => {})
  }

  // --- 顶部栏 ---
  const headerEl = document.createElement("header")
  headerEl.className = "mux-panel-header"

  const titleGroup = document.createElement("div")
  titleGroup.className = "mux-panel-title-group"
  const titleEl = document.createElement("h1")
  titleEl.className = "mux-panel-title"
  titleEl.textContent = "Mux 任务"
  const backendBadgeSlot = document.createElement("span")
  const backendBadge: BadgeHandle = mountBadge(backendBadgeSlot, { label: "检测中", tone: "neutral" })

  const scopeWrap = document.createElement("div")
  scopeWrap.className = "mux-segmented"
  const scopeProjectBtn = document.createElement("button")
  scopeProjectBtn.type = "button"
  scopeProjectBtn.className = "mux-seg-btn"
  scopeProjectBtn.textContent = "当前项目"
  const scopeAllBtn = document.createElement("button")
  scopeAllBtn.type = "button"
  scopeAllBtn.className = "mux-seg-btn"
  scopeAllBtn.textContent = "全部项目"
  scopeWrap.append(scopeProjectBtn, scopeAllBtn)

  titleGroup.append(titleEl, backendBadgeSlot, scopeWrap)

  const headerActions = document.createElement("div")
  headerActions.className = "mux-panel-header-actions"

  const cleanHistoryBtn = mountButton(headerActions, {
    label: "清理历史",
    variant: "ghost",
    size: "sm",
    onClick: () => {
      if (historyController.open()) {
        historyDialogCancelNode?.focus()
      }
    },
  })

  const toggleLauncherBtn = mountButton(headerActions, {
    label: "+ 新建任务",
    variant: "outline",
    size: "sm",
    onClick: () => {
      launcherOpen = !launcherOpen
      render()
    },
  })

  const refreshBtn = mountButton(headerActions, {
    label: "刷新",
    variant: "ghost",
    size: "sm",
    onClick: () => {
      void poller.triggerNow()
    },
  })

  const cleanHistoryBtnNode = headerActions.children[0] as HTMLElement
  headerEl.append(titleGroup, headerActions)

  // --- 新建任务卡片 ---
  const launcherEl = document.createElement("section")
  launcherEl.className = "mux-launcher"
  launcherEl.hidden = true

  const launcherTop = document.createElement("div")
  launcherTop.className = "mux-launcher-top"
  const roleSwitchWrap = document.createElement("div")
  roleSwitchWrap.className = "mux-segmented"
  const roleBuildBtn = document.createElement("button")
  roleBuildBtn.type = "button"
  roleBuildBtn.className = "mux-seg-btn"
  roleBuildBtn.textContent = "构建任务"
  const roleServiceBtn = document.createElement("button")
  roleServiceBtn.type = "button"
  roleServiceBtn.className = "mux-seg-btn"
  roleServiceBtn.textContent = "后台服务"
  roleSwitchWrap.append(roleBuildBtn, roleServiceBtn)

  const launcherHint = document.createElement("span")
  launcherHint.className = "mux-launcher-hint"
  launcherTop.append(roleSwitchWrap, launcherHint)

  const launcherGrid = document.createElement("div")
  launcherGrid.className = "mux-launcher-grid"
  const nameFieldSlot = document.createElement("div")
  const cmdFieldSlot = document.createElement("div")
  const cwdFieldSlot = document.createElement("div")
  cwdFieldSlot.className = "mux-launcher-cwd"
  launcherGrid.append(nameFieldSlot, cmdFieldSlot, cwdFieldSlot)

  const nameField: TextFieldHandle = mountTextField(nameFieldSlot, {
    label: "任务名称",
    value: draftName,
    placeholder: "例如：typecheck 或 api",
    onChange: (value) => {
      draftName = value
      nameField.update({ value })
    },
  })

  const cmdField: TextFieldHandle = mountTextField(cmdFieldSlot, {
    label: "执行命令",
    value: draftCommand,
    placeholder: "例如：bun run typecheck",
    mono: true,
    onChange: (value) => {
      draftCommand = value
      cmdField.update({ value })
    },
  })

  const cwdField: TextFieldHandle = mountTextField(cwdFieldSlot, {
    label: "工作目录",
    value: draftCwd,
    placeholder: "/path/to/project",
    mono: true,
    onChange: (value) => {
      draftCwd = value
      draftCwdTouched = true
      cwdField.update({ value })
    },
  })

  const launcherFoot = document.createElement("div")
  launcherFoot.className = "mux-launcher-foot"
  const cancelLaunchBtn = mountButton(launcherFoot, {
    label: "取消",
    variant: "ghost",
    size: "sm",
    onClick: () => {
      launcherOpen = false
      render()
    },
  })
  const submitLaunchBtn = mountButton(launcherFoot, {
    label: "运行构建",
    variant: "default",
    size: "sm",
    onClick: () => {
      void submitLauncher()
    },
  })

  launcherEl.append(launcherTop, launcherGrid, launcherFoot)

  // 回车快速提交新建任务（忽略中文输入法组合键）
  launcherEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submitLauncher()
    }
  })

  // --- 横幅与筛选栏 ---
  const bannerSlot = document.createElement("div")
  let bannerHandle: BannerHandle | null = null

  const filterBar = document.createElement("div")
  filterBar.className = "mux-filter-bar"
  const tabsSlot = document.createElement("div")
  const summaryPillsEl = document.createElement("div")
  summaryPillsEl.className = "mux-summary-pills"
  filterBar.append(tabsSlot, summaryPillsEl)

  const filterTabs: TabsHandle = mountTabs(tabsSlot, {
    items: [
      { id: "all", label: "全部", count: 0 },
      { id: "build", label: "构建", count: 0 },
      { id: "service", label: "后台服务", count: 0 },
    ],
    activeId: roleFilter,
    trackBackground: true,
    onChange: (next) => {
      roleFilter = next as RoleFilter
      filterTabs.update({ activeId: roleFilter })
      render()
    },
  })

  const loadingSlot = document.createElement("div")
  const spinner = mountSpinner(loadingSlot, { label: "正在加载 Mux 任务..." })

  const globalEmptySlot = document.createElement("div")
  let globalEmptyHandle: EmptyHandle | null = null

  // --- 主从工作区 ---
  const workspaceEl = document.createElement("div")
  workspaceEl.className = "mux-workspace"

  const listPane = document.createElement("div")
  listPane.className = "mux-list-pane"

  const inspectorPane = document.createElement("section")
  inspectorPane.className = "mux-inspector"

  const inspectorEmptySlot = document.createElement("div")
  let inspectorEmptyHandle: EmptyHandle | null = null

  const inspectorBody = document.createElement("div")
  inspectorBody.style.display = "flex"
  inspectorBody.style.flexDirection = "column"
  inspectorBody.style.gap = "8px"
  inspectorBody.style.flex = "1 1 auto"
  inspectorBody.style.minHeight = "0"

  const inspectorHead = document.createElement("div")
  inspectorHead.className = "mux-inspector-head"

  const inspectorTitleBlock = document.createElement("div")
  inspectorTitleBlock.className = "mux-inspector-title-block"
  const inspectorTitleRow = document.createElement("div")
  inspectorTitleRow.className = "mux-inspector-title-row"
  const inspectorDot = document.createElement("span")
  inspectorDot.className = "mux-dot"
  const inspectorName = document.createElement("h2")
  inspectorName.className = "mux-inspector-name"
  const inspectorRolePill = document.createElement("span")
  inspectorRolePill.className = "mux-pill"
  const inspectorStatusSlot = document.createElement("span")
  const inspectorStatusBadge: BadgeHandle = mountBadge(inspectorStatusSlot, { label: "运行中", tone: "info" })
  const inspectorExitPill = document.createElement("span")
  inspectorExitPill.className = "mux-pill mux-mono mux-num"
  const inspectorRestartPill = document.createElement("span")
  inspectorRestartPill.className = "mux-pill mux-num"
  const inspectorSourcePill = document.createElement("span")
  inspectorSourcePill.className = "mux-pill"

  inspectorTitleRow.append(
    inspectorDot,
    inspectorName,
    inspectorRolePill,
    inspectorStatusSlot,
    inspectorExitPill,
    inspectorRestartPill,
    inspectorSourcePill,
  )
  inspectorTitleBlock.append(inspectorTitleRow)

  const inspectorActions = document.createElement("div")
  inspectorActions.className = "mux-inspector-actions"

  const inspPrimaryBtn: ButtonHandle = mountButton(inspectorActions, {
    label: "重试",
    variant: "outline",
    size: "sm",
    onClick: () => {
      const target = getSelectedTask()
      if (!target) return
      void runAction(`${target.id}:restart`, async () => {
        stopTimedOutIds.delete(target.id)
        await client.restartTask(target.id)
        showToast("success", target.role === "build" ? `已重新运行 ${target.name}` : `已启动 ${target.name}`)
      })
    },
  })
  const inspStopBtn: ButtonHandle = mountButton(inspectorActions, {
    label: "停止",
    variant: "outline",
    size: "sm",
    onClick: () => {
      const target = getSelectedTask()
      if (!target) return
      void runAction(`${target.id}:stop`, async () => {
        const res = await client.stopTask(target.id, { force: false })
        if (res.timedOut) {
          stopTimedOutIds.add(target.id)
          showToast("info", `${target.name} 未响应 Ctrl+C，可点击「强停」立即终止`)
        } else {
          stopTimedOutIds.delete(target.id)
          showToast("success", `已停止 ${target.name}`)
        }
      })
    },
  })
  const inspForceBtn: ButtonHandle = mountButton(inspectorActions, {
    label: "强停",
    variant: "destructive",
    size: "sm",
    onClick: () => {
      const target = getSelectedTask()
      if (!target) return
      void runAction(`${target.id}:force`, async () => {
        await client.stopTask(target.id, { force: true })
        stopTimedOutIds.delete(target.id)
        showToast("success", `已强制停止 ${target.name}`)
      })
    },
  })
  const inspRemoveBtn: ButtonHandle = mountButton(inspectorActions, {
    label: "移除",
    variant: "ghost",
    size: "sm",
    onClick: () => {
      const target = getSelectedTask()
      if (!target) return
      inspConfirmRemoveTaskId = inspConfirmRemoveTaskId === target.id ? null : target.id
      renderInspector()
    },
  })
  const [inspPrimaryNode, inspStopNode, inspForceNode, inspRemoveNode] = Array.from(
    inspectorActions.children,
  ) as HTMLElement[]

  inspectorHead.append(inspectorTitleBlock, inspectorActions)

  const inspConfirmBar = document.createElement("div")
  inspConfirmBar.className = "mux-insp-confirm"
  inspConfirmBar.hidden = true
  const inspConfirmText = document.createElement("span")
  inspConfirmText.className = "mux-insp-confirm-text"
  const inspConfirmBtns = document.createElement("div")
  inspConfirmBtns.className = "mux-insp-confirm-btns"
  const inspConfirmCancelBtn = mountButton(inspConfirmBtns, {
    label: "取消",
    variant: "ghost",
    size: "xs",
    onClick: () => {
      inspConfirmRemoveTaskId = null
      renderInspector()
    },
  })
  const inspConfirmOkBtn = mountButton(inspConfirmBtns, {
    label: "确认移除",
    variant: "destructive",
    size: "xs",
    onClick: () => {
      const target = getSelectedTask()
      if (!target) return
      void executeRemoveTask(target)
    },
  })
  inspConfirmBar.append(inspConfirmText, inspConfirmBtns)

  const inspectorCmdEl = document.createElement("div")
  inspectorCmdEl.className = "mux-inspector-cmd mux-mono"

  const metaGridEl = document.createElement("div")
  metaGridEl.className = "mux-meta-grid"

  const attachChipBtn = document.createElement("button")
  attachChipBtn.type = "button"
  attachChipBtn.className = "mux-attach-chip"
  const attachChipCmd = document.createElement("span")
  attachChipCmd.className = "mux-attach-chip-cmd"
  const attachChipTag = document.createElement("span")
  attachChipTag.className = "mux-attach-chip-tag"
  attachChipTag.textContent = "复制 Attach"
  attachChipBtn.append(attachChipCmd, attachChipTag)
  attachChipBtn.addEventListener("click", () => {
    const target = getSelectedTask()
    if (!target || !isAttachable(target)) return
    void copyTextWithToast(host, target.attachCommand, `已复制: ${target.attachCommand}`)
  })

  // 日志工具栏
  const logToolbar = document.createElement("div")
  logToolbar.className = "mux-log-toolbar"
  const logToolbarLeft = document.createElement("div")
  logToolbarLeft.className = "mux-log-toolbar-left"
  const logToolbarRight = document.createElement("div")
  logToolbarRight.className = "mux-log-toolbar-right"

  const linesSelectSlot = document.createElement("div")
  const linesSelect: SelectHandle = mountSelect(linesSelectSlot, {
    value: String(logLines),
    options: [
      { id: "80", label: "80 行" },
      { id: "200", label: "200 行" },
      { id: "500", label: "500 行" },
    ],
    onChange: (next) => {
      logLines = Number(next) || 200
      linesSelect.update({ value: String(logLines) })
      if (selectedTaskId) void fetchSelectedLogs(selectedTaskId)
    },
  })

  const autoRefreshSlot = document.createElement("div")
  const autoRefreshSwitch = mountSwitch(autoRefreshSlot, {
    label: "自动刷新",
    checked: autoRefreshLogs,
    onChange: (checked) => {
      autoRefreshLogs = checked
      autoRefreshSwitch.update({ checked })
      if (checked && selectedTaskId) void fetchSelectedLogs(selectedTaskId)
    },
  })

  logToolbarLeft.append(linesSelectSlot, autoRefreshSlot)

  const refreshLogsBtn = mountButton(logToolbarRight, {
    label: "刷新日志",
    variant: "outline",
    size: "xs",
    onClick: () => {
      if (selectedTaskId) void fetchSelectedLogs(selectedTaskId)
    },
  })
  const copyLogsBtn = mountButton(logToolbarRight, {
    label: "复制日志",
    variant: "ghost",
    size: "xs",
    onClick: () => {
      const content = logViewport.getText()
      if (!content) {
        showToast("info", "当前没有可复制的日志内容")
        return
      }
      void copyTextWithToast(host, content, "已复制终端日志")
    },
  })

  logToolbar.append(logToolbarLeft, logToolbarRight)

  const logViewport: LogViewport = createLogViewport()

  // 标准输入（stdin）发送栏
  const stdinBar = document.createElement("div")
  stdinBar.className = "mux-stdin-bar"
  const stdinInputWrap = document.createElement("div")
  stdinInputWrap.className = "mux-stdin-input-wrap"
  const stdinControls = document.createElement("div")
  stdinControls.className = "mux-stdin-controls"

  const stdinField: TextFieldHandle = mountTextField(stdinInputWrap, {
    value: "",
    placeholder: "发送标准输入（如 rs、y，留空按 Enter 发送回车）...",
    mono: true,
    onChange: (value) => {
      if (selectedTaskId) stdinDrafts.set(selectedTaskId, value)
      stdinField.update({ value })
    },
  })

  const stdinEnterWrap = document.createElement("div")
  const stdinEnterCheck: CheckboxHandle = mountCheckbox(stdinEnterWrap, {
    label: "回车",
    checked: stdinEnter,
    onChange: (checked) => {
      stdinEnter = checked
      stdinEnterCheck.update({ checked })
    },
  })

  const sendStdinBtn: ButtonHandle = mountButton(stdinControls, {
    label: "发送",
    variant: "default",
    size: "sm",
    onClick: () => {
      void handleSendStdin()
    },
  })
  stdinControls.prepend(stdinEnterWrap)
  stdinBar.append(stdinInputWrap, stdinControls)

  stdinInputWrap.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void handleSendStdin()
    }
  })

  inspectorBody.append(
    inspectorHead,
    inspConfirmBar,
    inspectorCmdEl,
    metaGridEl,
    attachChipBtn,
    logToolbar,
    logViewport.element,
    stdinBar,
  )
  inspectorPane.append(inspectorEmptySlot, inspectorBody)

  workspaceEl.append(listPane, inspectorPane)

  // --- 关闭会话确认弹层 ---
  const closeDialogBackdrop = document.createElement("div")
  closeDialogBackdrop.className = "mux-dialog-backdrop"
  closeDialogBackdrop.hidden = true

  const closeDialogEl = document.createElement("div")
  closeDialogEl.className = "mux-dialog oc-sdk-popup"
  closeDialogEl.setAttribute("role", "dialog")
  closeDialogEl.setAttribute("aria-modal", "true")
  closeDialogEl.setAttribute("aria-labelledby", "mux-close-dialog-title")

  const closeDialogHead = document.createElement("div")
  closeDialogHead.className = "mux-dialog-head"
  const closeDialogTitle = document.createElement("h2")
  closeDialogTitle.id = "mux-close-dialog-title"
  closeDialogTitle.className = "mux-dialog-title"
  closeDialogTitle.textContent = "关闭会话"
  const closeDialogMeta = document.createElement("div")
  closeDialogMeta.className = "mux-dialog-meta"
  closeDialogHead.append(closeDialogTitle, closeDialogMeta)

  const closeDialogBody = document.createElement("p")
  closeDialogBody.className = "mux-dialog-body"

  const closeDialogErrorEl = document.createElement("div")
  closeDialogErrorEl.className = "mux-dialog-error"
  closeDialogErrorEl.hidden = true

  const closeDialogFoot = document.createElement("div")
  closeDialogFoot.className = "mux-dialog-foot"
  const closeDialogCancelBtn = mountButton(closeDialogFoot, {
    label: "取消",
    variant: "outline",
    size: "sm",
    onClick: () => {
      if (pendingCloseSession && busyActions.has(sessionBusyKey(pendingCloseSession.muxSession))) return
      pendingCloseSession = null
      closeDialogError = ""
      renderCloseDialog()
    },
  })
  const closeDialogConfirmBtn = mountButton(closeDialogFoot, {
    label: "确认关闭会话",
    variant: "destructive",
    size: "sm",
    onClick: () => {
      void executeCloseSession()
    },
  })
  const closeDialogCancelNode = closeDialogFoot.children[0] as HTMLButtonElement | undefined

  closeDialogEl.append(closeDialogHead, closeDialogBody, closeDialogErrorEl, closeDialogFoot)
  closeDialogBackdrop.append(closeDialogEl)

  closeDialogBackdrop.addEventListener("click", (event) => {
    if (event.target !== closeDialogBackdrop) return
    if (pendingCloseSession && busyActions.has(sessionBusyKey(pendingCloseSession.muxSession))) return
    pendingCloseSession = null
    closeDialogError = ""
    renderCloseDialog()
  })

  // --- 清理历史确认弹层 ---
  const historyDialogBackdrop = document.createElement("div")
  historyDialogBackdrop.className = "mux-dialog-backdrop"
  historyDialogBackdrop.hidden = true

  const historyDialogEl = document.createElement("div")
  historyDialogEl.className = "mux-dialog mux-dialog--wide oc-sdk-popup"
  historyDialogEl.setAttribute("role", "dialog")
  historyDialogEl.setAttribute("aria-modal", "true")
  historyDialogEl.setAttribute("aria-labelledby", "mux-history-dialog-title")

  const historyDialogHead = document.createElement("div")
  historyDialogHead.className = "mux-dialog-head"
  const historyDialogTitle = document.createElement("h2")
  historyDialogTitle.id = "mux-history-dialog-title"
  historyDialogTitle.className = "mux-dialog-title mux-dialog-title--neutral"
  historyDialogTitle.textContent = "清理历史记录"
  const historyDialogMeta = document.createElement("div")
  historyDialogMeta.className = "mux-dialog-meta"
  historyDialogHead.append(historyDialogTitle, historyDialogMeta)

  const historyOptionSlot = document.createElement("div")
  const historyIncludeShellCheck: CheckboxHandle = mountCheckbox(historyOptionSlot, {
    label: "包含驻留 shell 任务",
    description: "同时关闭对应终端窗格",
    checked: false,
    onChange: (checked) => {
      historyController.setIncludeShell(checked)
    },
  })

  const historyLoadingSlot = document.createElement("div")
  historyLoadingSlot.hidden = true
  const historySpinner = mountSpinner(historyLoadingSlot, { size: "sm", label: "正在扫描可清理记录..." })

  const historySummaryEl = document.createElement("div")
  historySummaryEl.className = "mux-history-summary"
  historySummaryEl.hidden = true

  const historyPreviewList = document.createElement("div")
  historyPreviewList.className = "mux-history-list"
  historyPreviewList.hidden = true

  const historyEmptyEl = document.createElement("div")
  historyEmptyEl.className = "mux-history-empty"
  historyEmptyEl.hidden = true

  const historyResultEl = document.createElement("div")
  historyResultEl.className = "mux-history-result"
  historyResultEl.hidden = true

  const historyErrorEl = document.createElement("div")
  historyErrorEl.className = "mux-dialog-error"
  historyErrorEl.hidden = true

  const historyDialogFoot = document.createElement("div")
  historyDialogFoot.className = "mux-dialog-foot"
  const historyCancelBtn = mountButton(historyDialogFoot, {
    label: "取消",
    variant: "outline",
    size: "sm",
    onClick: () => {
      historyController.close()
    },
  })
  const historyRetryBtn = mountButton(historyDialogFoot, {
    label: "重新扫描",
    variant: "default",
    size: "sm",
    onClick: () => {
      historyController.retryPreview()
    },
  })
  const historyConfirmBtn = mountButton(historyDialogFoot, {
    label: "确认清理",
    variant: "destructive",
    size: "sm",
    onClick: () => {
      void historyController.confirm()
    },
  })
  const [historyDialogCancelNode, historyRetryNode, historyConfirmNode] = Array.from(
    historyDialogFoot.children,
  ) as HTMLElement[]

  historyDialogEl.append(
    historyDialogHead,
    historyOptionSlot,
    historyLoadingSlot,
    historySummaryEl,
    historyPreviewList,
    historyEmptyEl,
    historyResultEl,
    historyErrorEl,
    historyDialogFoot,
  )
  historyDialogBackdrop.append(historyDialogEl)

  historyDialogBackdrop.addEventListener("click", (event) => {
    if (event.target !== historyDialogBackdrop) return
    historyController.close()
  })

  function clearRemovedTaskUiState(removedIds: readonly string[]): void {
    for (const id of removedIds) {
      if (selectedTaskId === id) selectedTaskId = null
      if (confirmRemoveTaskId === id) confirmRemoveTaskId = null
      if (inspConfirmRemoveTaskId === id) inspConfirmRemoveTaskId = null
      stopTimedOutIds.delete(id)
      stdinDrafts.delete(id)
    }
  }

  function renderHistoryDialog(): void {
    const state = historyController.getState()
    historyDialogBackdrop.hidden = !state
    if (!state) return

    historyDialogMeta.textContent = ""
    const pathSpan = document.createElement("span")
    pathSpan.className = "mux-mono"
    pathSpan.textContent = shortPath(state.targetCwd)
    pathSpan.title = state.targetCwd
    historyDialogMeta.append(pathSpan, "·", "失效记录及超过 7 天已结束任务")

    historyIncludeShellCheck.update({
      checked: state.includeShell,
      disabled: state.cleaning,
    })

    historyLoadingSlot.hidden = !state.previewLoading

    const showPreview = !state.previewLoading && !state.previewError && state.cleanResult === null
    if (showPreview && state.previewTasks.length > 0) {
      const shellCount = state.previewTasks.filter((t) => t.shell).length
      historySummaryEl.hidden = false
      historySummaryEl.textContent = shellCount > 0
        ? `共 ${state.previewTasks.length} 条可清理记录（含 ${shellCount} 个驻留 shell）`
        : `共 ${state.previewTasks.length} 条可清理记录`

      historyPreviewList.hidden = false
      historyPreviewList.textContent = ""
      for (const item of state.previewTasks) {
        const row = document.createElement("div")
        row.className = "mux-history-item"

        const rowTop = document.createElement("div")
        rowTop.className = "mux-history-row-top"
        const dot = document.createElement("span")
        dot.className = "mux-dot"
        dot.dataset.status = item.status
        const nameEl = document.createElement("span")
        nameEl.className = "mux-history-name"
        nameEl.textContent = item.name
        nameEl.title = item.name

        const rolePill = document.createElement("span")
        rolePill.className = "mux-pill"
        rolePill.textContent = roleLabel(item.role)

        const statusMetaInfo = statusMeta(item.status)
        const statusPill = document.createElement("span")
        statusPill.className = "mux-pill"
        if (statusMetaInfo.tone !== "neutral") {
          statusPill.dataset.tone = statusMetaInfo.tone
        }
        statusPill.textContent = statusMetaInfo.label

        rowTop.append(dot, nameEl, rolePill, statusPill)

        if (item.shell) {
          const shellPill = document.createElement("span")
          shellPill.className = "mux-pill"
          shellPill.dataset.tone = "warning"
          shellPill.textContent = "驻留 shell"
          rowTop.append(shellPill)
        }

        const timeEl = document.createElement("span")
        timeEl.className = "mux-history-time mux-num"
        timeEl.textContent = formatRelativeTime(item.updatedAt)
        timeEl.title = item.updatedAt
        rowTop.append(timeEl)

        const cmdEl = document.createElement("div")
        cmdEl.className = "mux-history-cmd mux-mono"
        cmdEl.textContent = `$ ${item.command}`
        cmdEl.title = item.command

        row.append(rowTop, cmdEl)
        historyPreviewList.append(row)
      }
      historyEmptyEl.hidden = true
    } else {
      historySummaryEl.hidden = true
      historyPreviewList.hidden = true
      if (showPreview) {
        historyEmptyEl.hidden = false
        historyEmptyEl.textContent = state.includeShell
          ? "当前项目暂无可清理的历史记录"
          : "当前项目暂无可清理的历史记录（默认保留驻留 shell）"
      } else {
        historyEmptyEl.hidden = true
      }
    }

    if (state.cleanResult !== null) {
      const res = state.cleanResult
      historyResultEl.hidden = false
      historyResultEl.textContent = ""

      const countsRow = document.createElement("div")
      countsRow.className = "mux-history-result-counts"
      const removedPill = document.createElement("span")
      removedPill.className = "mux-pill mux-num"
      removedPill.dataset.tone = res.removed.length > 0 ? "success" : "neutral"
      removedPill.textContent = `已清理 ${res.removed.length} 项`
      countsRow.append(removedPill)
      if (res.skipped.length > 0) {
        const skippedPill = document.createElement("span")
        skippedPill.className = "mux-pill mux-num"
        skippedPill.dataset.tone = "warning"
        skippedPill.textContent = `已跳过 ${res.skipped.length} 项`
        countsRow.append(skippedPill)
      }
      if (res.failed.length > 0) {
        const failedPill = document.createElement("span")
        failedPill.className = "mux-pill mux-num"
        failedPill.dataset.tone = "error"
        failedPill.textContent = `失败 ${res.failed.length} 项`
        countsRow.append(failedPill)
      }
      historyResultEl.append(countsRow)

      if (res.skipped.length > 0) {
        const group = document.createElement("div")
        group.className = "mux-history-result-group"
        const label = document.createElement("div")
        label.className = "mux-history-result-label"
        label.textContent = "已跳过（状态已变化）"
        const list = document.createElement("ul")
        list.className = "mux-history-result-items"
        for (const id of res.skipped) {
          const li = document.createElement("li")
          li.textContent = state.previewNameById.get(id) ?? id
          list.append(li)
        }
        group.append(label, list)
        historyResultEl.append(group)
      }

      if (res.failed.length > 0) {
        const group = document.createElement("div")
        group.className = "mux-history-result-group"
        const label = document.createElement("div")
        label.className = "mux-history-result-label"
        label.textContent = "清理失败"
        const list = document.createElement("ul")
        list.className = "mux-history-result-items mux-history-result-items--error"
        for (const entry of res.failed) {
          const li = document.createElement("li")
          const taskName = state.previewNameById.get(entry.id) ?? entry.id
          li.textContent = `${taskName}：${entry.message}`
          list.append(li)
        }
        group.append(label, list)
        historyResultEl.append(group)
      }
    } else {
      historyResultEl.hidden = true
    }

    const errorMessage = state.previewError || state.cleanError
    historyErrorEl.hidden = !errorMessage
    if (errorMessage) {
      historyErrorEl.textContent = errorMessage
    }

    const showRetry = Boolean(state.previewError) || state.cleanResult !== null
    historyCancelBtn.update({
      label: state.cleanResult !== null ? "关闭" : "取消",
      disabled: state.cleaning,
    })
    historyRetryNode.hidden = !showRetry
    historyRetryBtn.update({
      disabled: state.cleaning,
    })
    historyConfirmNode.hidden = showRetry
    historyConfirmBtn.update({
      label: state.previewTasks.length > 0 ? `确认清理 (${state.previewTasks.length})` : "确认清理",
      loading: state.cleaning,
      disabled: state.previewLoading || state.cleaning || state.previewTasks.length === 0,
    })
  }

  const historyController = createHistoryDialogController({
    client,
    getCurrentDirectory: () => currentDirectory,
    onChange: renderHistoryDialog,
    onRemoved: clearRemovedTaskUiState,
    onNotify: showToast,
    onRefresh: () => {
      void poller.triggerNow()
    },
  })

  const handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return
    if (historyController.getState()) {
      historyController.close()
      return
    }
    if (pendingCloseSession) {
      if (busyActions.has(sessionBusyKey(pendingCloseSession.muxSession))) return
      pendingCloseSession = null
      closeDialogError = ""
      renderCloseDialog()
      return
    }
    if (confirmRemoveTaskId || inspConfirmRemoveTaskId) {
      confirmRemoveTaskId = null
      inspConfirmRemoveTaskId = null
      render()
    }
  }
  window.addEventListener("keydown", handleGlobalKeydown)

  app.append(
    headerEl,
    launcherEl,
    bannerSlot,
    filterBar,
    loadingSlot,
    globalEmptySlot,
    workspaceEl,
    closeDialogBackdrop,
    historyDialogBackdrop,
  )

  // --- 事件绑定 ---
  scopeProjectBtn.addEventListener("click", () => {
    if (scope === "project") return
    scope = "project"
    render()
    void poller.triggerNow({ invalidate: true })
  })
  scopeAllBtn.addEventListener("click", () => {
    if (scope === "all") return
    scope = "all"
    render()
    void poller.triggerNow({ invalidate: true })
  })

  roleBuildBtn.addEventListener("click", () => {
    launcherRole = "build"
    renderLauncher()
  })
  roleServiceBtn.addEventListener("click", () => {
    launcherRole = "service"
    renderLauncher()
  })

  // --- 辅助函数 ---
  function getSelectedTask(): TaskView | undefined {
    if (!selectedTaskId) return undefined
    return tasks.find((t) => t.id === selectedTaskId)
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

  function setGlobalEmpty(props: Parameters<typeof mountEmpty>[1] | null): void {
    if (!props) {
      globalEmptyHandle?.dispose()
      globalEmptyHandle = null
      globalEmptySlot.hidden = true
      return
    }
    globalEmptySlot.hidden = false
    if (!globalEmptyHandle) {
      globalEmptyHandle = mountEmpty(globalEmptySlot, props)
    } else {
      globalEmptyHandle.update(props)
    }
  }

  function setInspectorEmpty(props: Parameters<typeof mountEmpty>[1] | null): void {
    if (!props) {
      inspectorEmptyHandle?.dispose()
      inspectorEmptyHandle = null
      inspectorEmptySlot.hidden = true
      return
    }
    inspectorEmptySlot.hidden = false
    if (!inspectorEmptyHandle) {
      inspectorEmptyHandle = mountEmpty(inspectorEmptySlot, props)
    } else {
      inspectorEmptyHandle.update(props)
    }
  }

  async function submitLauncher(): Promise<void> {
    if (launching) return
    const name = draftName.trim()
    const command = draftCommand.trim()
    const cwd = draftCwd.trim()
    if (!name) {
      showToast("error", "请填写任务名称")
      return
    }
    if (!command) {
      showToast("error", "请填写要执行的命令")
      return
    }
    if (!cwd) {
      showToast("error", "请填写工作目录")
      return
    }

    launching = true
    renderLauncher()
    try {
      if (launcherRole === "build") {
        const res = await client.runBuild({ name, command, cwd, wait: false })
        selectedTaskId = res.task.id
        showToast("success", `已启动构建任务 ${res.task.name}`)
      } else {
        const res = await client.serviceAction({
          action: "start",
          name,
          command,
          cwd,
          restartIfRunning: true,
        })
        if (res.task) selectedTaskId = res.task.id
        showToast("success", `已启动后台服务 ${name}`)
      }
      draftName = ""
      draftCommand = ""
      nameField.update({ value: "" })
      cmdField.update({ value: "" })
      launcherOpen = false
      await poller.triggerNow()
      if (selectedTaskId) void fetchSelectedLogs(selectedTaskId)
    } catch (error) {
      showToast("error", formatClientError(error).detail)
    } finally {
      launching = false
      render()
    }
  }

  async function handleSendStdin(): Promise<void> {
    const target = getSelectedTask()
    if (!target || target.status !== "running") return
    const value = stdinDrafts.get(target.id) ?? ""
    if (!value && !stdinEnter) {
      showToast("info", "请输入内容或勾选「回车」后发送")
      return
    }
    await runAction(`${target.id}:input`, async () => {
      await client.sendInput(target.id, { input: value, enter: stdinEnter })
      stdinDrafts.set(target.id, "")
      stdinField.update({ value: "" })
      await fetchSelectedLogs(target.id)
    })
  }

  function sessionBusyKey(muxSession: string): string {
    return `session:${muxSession}:close`
  }

  async function executeRemoveTask(task: TaskView): Promise<void> {
    const key = `${task.id}:remove`
    if (busyActions.has(key) || busyActions.has(sessionBusyKey(task.muxSession))) return
    await runAction(key, async () => {
      let alreadyGone = false
      let res: { ok?: boolean; timedOut?: boolean } | undefined
      try {
        res = await client.removeTask(task.id)
      } catch (error) {
        // 404 视为已移除，按成功处理并刷新列表
        if (error instanceof ServiceApiError && error.status === 404) {
          alreadyGone = true
        } else {
          throw error
        }
      }
      if (confirmRemoveTaskId === task.id) confirmRemoveTaskId = null
      if (inspConfirmRemoveTaskId === task.id) inspConfirmRemoveTaskId = null
      if (selectedTaskId === task.id) selectedTaskId = null
      stopTimedOutIds.delete(task.id)
      stdinDrafts.delete(task.id)
      if (alreadyGone) {
        showToast("info", `${task.name} 已不存在，已从列表移除`)
      } else if (res?.timedOut) {
        showToast("info", `${task.name} 停止超时，已尝试强制终止并移除`)
      } else {
        showToast("success", `已移除 ${task.name}`)
      }
    })
  }

  async function executeCloseSession(): Promise<void> {
    const target = pendingCloseSession
    if (!target) return
    const key = sessionBusyKey(target.muxSession)
    if (busyActions.has(key)) return

    busyActions.add(key)
    closeDialogError = ""
    render()
    try {
      const res = await client.closeSession({ cwd: target.cwd })
      if (!res.ok) {
        throw new Error(`未能关闭会话 ${target.muxSession}`)
      }
      for (const task of tasks) {
        if (task.muxSession !== target.muxSession) continue
        if (selectedTaskId === task.id) selectedTaskId = null
        if (confirmRemoveTaskId === task.id) confirmRemoveTaskId = null
        if (inspConfirmRemoveTaskId === task.id) inspConfirmRemoveTaskId = null
        stopTimedOutIds.delete(task.id)
        stdinDrafts.delete(task.id)
      }
      pendingCloseSession = null
      closeDialogError = ""
      const closedName = res.sessionName || target.muxSession
      showToast("success", `已关闭会话 ${closedName}，移除 ${res.removed} 条记录`)
    } catch (error) {
      const detail = formatClientError(error).detail
      closeDialogError = detail
      showToast("error", `关闭会话失败：${detail}`)
    } finally {
      busyActions.delete(key)
      await poller.triggerNow()
    }
  }

  function openCloseSessionDialog(group: SessionGroup): void {
    if (group.totalCount <= 0) return
    pendingCloseSession = {
      muxSession: group.muxSession,
      cwd: group.cwd,
      totalCount: group.totalCount,
      runningCount: group.runningCount,
    }
    closeDialogError = ""
    renderCloseDialog()
    closeDialogCancelNode?.focus()
  }

  function renderCloseDialog(): void {
    const target = pendingCloseSession
    closeDialogBackdrop.hidden = !target
    if (!target) return

    const closing = busyActions.has(sessionBusyKey(target.muxSession))
    closeDialogMeta.textContent = ""
    const sessionSpan = document.createElement("span")
    sessionSpan.className = "mux-mono"
    sessionSpan.textContent = target.muxSession
    const pathSpan = document.createElement("span")
    pathSpan.className = "mux-mono"
    pathSpan.textContent = shortPath(target.cwd)
    pathSpan.title = target.cwd
    closeDialogMeta.append(sessionSpan, "·", pathSpan)

    const runningNote = target.runningCount > 0 ? `（含运行中的服务，当前 ${target.runningCount} 个正在运行）` : "（含运行中的服务）"
    closeDialogBody.textContent =
      `确定要关闭会话 ${target.muxSession} 吗？此操作将终止该会话下全部 ${target.totalCount} 个任务${runningNote}，已 attach 的终端会被脱离，且操作不可撤销。`

    closeDialogErrorEl.hidden = !closeDialogError
    if (closeDialogError) {
      closeDialogErrorEl.textContent = closeDialogError
    }

    closeDialogCancelBtn.update({ disabled: closing })
    closeDialogConfirmBtn.update({ loading: closing, disabled: closing })
  }

  function groupVisibleTasks(allSorted: readonly TaskView[], visible: readonly TaskView[]): SessionGroup[] {
    const sessionTotals = new Map<string, { total: number; running: number }>()
    for (const task of allSorted) {
      const prev = sessionTotals.get(task.muxSession) ?? { total: 0, running: 0 }
      prev.total += 1
      if (task.status === "running") prev.running += 1
      sessionTotals.set(task.muxSession, prev)
    }

    const groupsMap = new Map<string, SessionGroup>()
    const groups: SessionGroup[] = []
    for (const task of visible) {
      let group = groupsMap.get(task.muxSession)
      if (!group) {
        const totals = sessionTotals.get(task.muxSession) ?? { total: 0, running: 0 }
        group = {
          muxSession: task.muxSession,
          cwd: task.cwd,
          visibleTasks: [],
          totalCount: totals.total,
          runningCount: totals.running,
        }
        groupsMap.set(task.muxSession, group)
        groups.push(group)
      }
      group.visibleTasks.push(task)
    }
    return groups
  }

  async function runAction(key: string, work: () => Promise<void>): Promise<void> {
    if (busyActions.has(key)) return
    busyActions.add(key)
    render()
    try {
      await work()
    } catch (error) {
      showToast("error", formatClientError(error).detail)
    } finally {
      busyActions.delete(key)
      await poller.triggerNow()
    }
  }

  async function fetchSelectedLogs(taskId: string): Promise<void> {
    logLoading = true
    refreshLogsBtn.update({ loading: true })
    try {
      const res = await client.getLogs(taskId, logLines)
      if (selectedTaskId !== taskId) return
      lastLogTaskId = taskId
      lastLogText = res.tail
      lastLogError = ""
    } catch (error) {
      if (selectedTaskId !== taskId) return
      lastLogTaskId = taskId
      lastLogText = ""
      lastLogError = formatClientError(error).detail
    } finally {
      logLoading = false
      refreshLogsBtn.update({ loading: false })
      renderInspector()
    }
  }

  // --- 任务卡片创建与增量同步 ---
  function createCardController(initialTask: TaskView): CardController {
    let task = initialTask

    const card = document.createElement("article")
    card.className = "mux-card"
    card.tabIndex = 0

    const top = document.createElement("div")
    top.className = "mux-card-top"
    const titleWrap = document.createElement("div")
    titleWrap.className = "mux-card-title-wrap"
    const dot = document.createElement("span")
    dot.className = "mux-dot"
    const nameEl = document.createElement("span")
    nameEl.className = "mux-card-name"
    titleWrap.append(dot, nameEl)

    const badgesWrap = document.createElement("div")
    badgesWrap.className = "mux-card-badges"
    const rolePill = document.createElement("span")
    rolePill.className = "mux-pill"
    const statusSlot = document.createElement("span")
    const statusBadge: BadgeHandle = mountBadge(statusSlot, { label: "运行中", tone: "info" })
    badgesWrap.append(rolePill, statusSlot)
    top.append(titleWrap, badgesWrap)

    const metaEl = document.createElement("div")
    metaEl.className = "mux-card-meta"
    const exitPill = document.createElement("span")
    exitPill.className = "mux-pill mux-mono mux-num"
    const restartSpan = document.createElement("span")
    restartSpan.className = "mux-num"
    const sourceSpan = document.createElement("span")
    const timeSpan = document.createElement("span")
    const cwdSpan = document.createElement("span")
    cwdSpan.className = "mux-mono"
    metaEl.append(exitPill, restartSpan, sourceSpan, timeSpan, cwdSpan)

    const cmdEl = document.createElement("div")
    cmdEl.className = "mux-card-cmd mux-mono"

    const actionsEl = document.createElement("div")
    actionsEl.className = "mux-card-actions"
    actionsEl.addEventListener("click", (event) => {
      // 点击操作按钮时同时选中该任务以便就地查看日志，但不重复触发卡片自身逻辑
      event.stopPropagation()
      selectTask(task.id)
    })

    const primaryBtn = mountButton(actionsEl, {
      label: "重试",
      variant: "outline",
      size: "xs",
      onClick: () => {
        void runAction(`${task.id}:restart`, async () => {
          stopTimedOutIds.delete(task.id)
          await client.restartTask(task.id)
          showToast("success", task.role === "build" ? `已重新运行 ${task.name}` : `已启动 ${task.name}`)
        })
      },
    })

    const stopBtn = mountButton(actionsEl, {
      label: "停止",
      variant: "outline",
      size: "xs",
      onClick: () => {
        void runAction(`${task.id}:stop`, async () => {
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

    const forceBtn = mountButton(actionsEl, {
      label: "强停",
      variant: "destructive",
      size: "xs",
      onClick: () => {
        void runAction(`${task.id}:force`, async () => {
          await client.stopTask(task.id, { force: true })
          stopTimedOutIds.delete(task.id)
          showToast("success", `已强制停止 ${task.name}`)
        })
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

    const removeBtn = mountButton(actionsEl, {
      label: "移除",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        confirmRemoveTaskId = confirmRemoveTaskId === task.id ? null : task.id
        render()
      },
    })

    const [primaryNode, stopNode, forceNode, attachNode, removeNode] = Array.from(
      actionsEl.children,
    ) as HTMLElement[]
    removeNode.classList.add("mux-card-remove")
    removeNode.title = "移除任务"

    const confirmBar = document.createElement("div")
    confirmBar.className = "mux-card-confirm"
    confirmBar.hidden = true
    confirmBar.addEventListener("click", (event) => {
      event.stopPropagation()
    })
    const confirmText = document.createElement("span")
    confirmText.className = "mux-card-confirm-text"
    const confirmBtns = document.createElement("div")
    confirmBtns.className = "mux-card-confirm-btns"
    const confirmCancelBtn = mountButton(confirmBtns, {
      label: "取消",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        confirmRemoveTaskId = null
        render()
      },
    })
    const confirmOkBtn = mountButton(confirmBtns, {
      label: "确认移除",
      variant: "destructive",
      size: "xs",
      onClick: () => {
        void executeRemoveTask(task)
      },
    })
    confirmBar.append(confirmText, confirmBtns)

    card.append(top, metaEl, cmdEl, actionsEl, confirmBar)

    card.addEventListener("click", () => {
      selectTask(task.id)
    })
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        selectTask(task.id)
      }
    })

    function update(nextTask: TaskView, selected: boolean): void {
      task = nextTask
      const meta = statusMeta(task.status)
      const isRunning = task.status === "running"
      const attachable = isAttachable(task)
      const removing = busyActions.has(`${task.id}:remove`)
      const sessionClosing = busyActions.has(sessionBusyKey(task.muxSession))
      const anyBusy =
        busyActions.has(`${task.id}:restart`)
        || busyActions.has(`${task.id}:stop`)
        || busyActions.has(`${task.id}:force`)
        || removing
        || sessionClosing
      const confirmingRemove = confirmRemoveTaskId === task.id

      card.dataset.selected = selected ? "true" : "false"
      card.dataset.status = task.status
      dot.dataset.status = task.status
      nameEl.textContent = task.name
      nameEl.title = task.name

      rolePill.textContent = roleLabel(task.role)
      statusBadge.update({ label: meta.label, tone: meta.tone })

      if (task.exitCode !== undefined && !isRunning) {
        exitPill.hidden = false
        exitPill.textContent = `exit ${task.exitCode}`
        exitPill.dataset.tone = task.exitCode === 0 ? "success" : "error"
      } else {
        exitPill.hidden = true
      }

      if (task.restartCount > 0) {
        restartSpan.hidden = false
        restartSpan.textContent = `重启 ×${task.restartCount}`
      } else {
        restartSpan.hidden = true
      }

      const srcText = sourceLabel(task.source)
      if (srcText) {
        sourceSpan.hidden = false
        sourceSpan.textContent = srcText
      } else {
        sourceSpan.hidden = true
      }

      timeSpan.textContent = formatRelativeTime(task.updatedAt)

      if (scope === "all" || !currentDirectory) {
        cwdSpan.hidden = false
        cwdSpan.textContent = shortPath(task.cwd)
        cwdSpan.title = task.cwd
      } else {
        cwdSpan.hidden = true
      }

      cmdEl.textContent = `$ ${task.command}`
      cmdEl.title = task.command

      actionsEl.hidden = confirmingRemove
      confirmBar.hidden = !confirmingRemove

      if (confirmingRemove) {
        confirmBar.dataset.running = isRunning ? "true" : "false"
        confirmText.textContent = isRunning ? "正在运行，终止并移除？" : "确认移除该任务？"
        confirmCancelBtn.update({ disabled: anyBusy })
        confirmOkBtn.update({
          label: isRunning ? "终止并移除" : "确认移除",
          loading: removing,
          disabled: anyBusy,
        })
      }

      if (isRunning) {
        primaryNode.hidden = false
        primaryBtn.update({
          label: task.role === "build" ? "重新运行" : "重启",
          variant: "outline",
          loading: busyActions.has(`${task.id}:restart`),
          disabled: anyBusy,
        })
        stopNode.hidden = false
        stopBtn.update({
          label: "停止",
          loading: busyActions.has(`${task.id}:stop`),
          disabled: anyBusy,
        })
        forceNode.hidden = false
        forceBtn.update({
          variant: stopTimedOutIds.has(task.id) ? "destructive" : "ghost",
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

      removeNode.hidden = false
      removeBtn.update({
        loading: removing,
        disabled: anyBusy,
      })

      attachNode.hidden = !attachable
      if (attachable) {
        attachNode.title = `复制命令: ${task.attachCommand}`
      }
    }

    update(initialTask, selectedTaskId === initialTask.id)

    return {
      element: card,
      update,
      dispose: () => {
        statusBadge.dispose()
        primaryBtn.dispose()
        stopBtn.dispose()
        forceBtn.dispose()
        attachBtn.dispose()
        removeBtn.dispose()
        confirmCancelBtn.dispose()
        confirmOkBtn.dispose()
        card.remove()
      },
    }
  }

  function createGroupController(initialGroup: SessionGroup): SessionGroupController {
    let group = initialGroup

    const section = document.createElement("section")
    section.className = "mux-session-group"

    const head = document.createElement("header")
    head.className = "mux-group-head"

    const info = document.createElement("div")
    info.className = "mux-group-info"

    const titleRow = document.createElement("div")
    titleRow.className = "mux-group-title-row"
    const projectEl = document.createElement("span")
    projectEl.className = "mux-group-project"
    const countPill = document.createElement("span")
    countPill.className = "mux-pill mux-num"
    titleRow.append(projectEl, countPill)

    const sessionEl = document.createElement("span")
    sessionEl.className = "mux-group-session mux-mono"

    info.append(titleRow, sessionEl)

    const actions = document.createElement("div")
    actions.className = "mux-group-actions"
    const closeBtn = mountButton(actions, {
      label: "关闭会话",
      variant: "destructive",
      size: "xs",
      onClick: () => {
        openCloseSessionDialog(group)
      },
    })
    const closeBtnNode = actions.children[0] as HTMLElement

    head.append(info, actions)

    const cardsContainer = document.createElement("div")
    cardsContainer.className = "mux-group-cards"

    section.append(head, cardsContainer)

    function update(nextGroup: SessionGroup): void {
      group = nextGroup
      section.dataset.session = group.muxSession
      projectEl.textContent = shortPath(group.cwd)
      projectEl.title = group.cwd

      countPill.textContent =
        group.runningCount > 0 ? `${group.runningCount} 运行 / ${group.totalCount}` : `${group.totalCount} 项`
      countPill.dataset.tone = group.runningCount > 0 ? "info" : "neutral"

      sessionEl.textContent = `会话 ${group.muxSession}`
      sessionEl.title = group.muxSession

      const closing = busyActions.has(sessionBusyKey(group.muxSession))
      closeBtnNode.hidden = group.totalCount === 0
      closeBtn.update({
        loading: closing,
        disabled: closing,
      })
    }

    update(initialGroup)

    return {
      element: section,
      cardsContainer,
      update,
      dispose: () => {
        closeBtn.dispose()
        section.remove()
      },
    }
  }

  function selectTask(id: string): void {
    const changed = selectedTaskId !== id
    selectedTaskId = id
    if (confirmRemoveTaskId && confirmRemoveTaskId !== id) {
      confirmRemoveTaskId = null
    }
    if (changed) {
      inspConfirmRemoveTaskId = null
      lastLogText = ""
      lastLogError = ""
      lastLogTaskId = null
      logViewport.resetPin()
    }
    render()
    if (changed) {
      const target = getSelectedTask()
      if (target && isAttachable(target)) {
        void fetchSelectedLogs(target.id)
      }
    }
  }

  function renderLauncher(): void {
    launcherEl.hidden = !launcherOpen
    toggleLauncherBtn.update({
      label: launcherOpen ? "收起新建" : "+ 新建任务",
      variant: launcherOpen ? "secondary" : "outline",
    })
    roleBuildBtn.setAttribute("aria-pressed", launcherRole === "build" ? "true" : "false")
    roleServiceBtn.setAttribute("aria-pressed", launcherRole === "service" ? "true" : "false")
    launcherHint.textContent =
      launcherRole === "build"
        ? "一次性构建/测试命令，失败后可 1 键重试"
        : "长期运行的开发服务，支持启停、重启与终端输入"

    cmdField.update({
      placeholder: launcherRole === "build" ? "例如：bun run typecheck" : "例如：npm run dev",
      disabled: launching,
    })
    nameField.update({ disabled: launching })
    cwdField.update({ disabled: launching })
    cancelLaunchBtn.update({ disabled: launching })
    submitLaunchBtn.update({
      label: launcherRole === "build" ? "运行构建" : "启动服务",
      loading: launching,
    })
  }

  function renderInspector(): void {
    const target = getSelectedTask()
    if (!target) {
      inspectorBody.hidden = true
      setInspectorEmpty({
        title: "选择一个任务",
        body: "点击左侧任务卡片，可在此查看终端实时日志、复制 Attach 命令或发送标准输入。",
      })
      return
    }

    setInspectorEmpty(null)
    inspectorBody.hidden = false

    const meta = statusMeta(target.status)
    const isRunning = target.status === "running"
    const attachable = isAttachable(target)
    const removing = busyActions.has(`${target.id}:remove`)
    const sessionClosing = busyActions.has(sessionBusyKey(target.muxSession))
    const anyBusy =
      busyActions.has(`${target.id}:restart`)
      || busyActions.has(`${target.id}:stop`)
      || busyActions.has(`${target.id}:force`)
      || removing
      || sessionClosing
    const confirmingRemove = inspConfirmRemoveTaskId === target.id

    inspectorDot.dataset.status = target.status
    inspectorName.textContent = target.name
    inspectorRolePill.textContent = roleLabel(target.role)
    inspectorStatusBadge.update({ label: meta.label, tone: meta.tone })

    if (target.exitCode !== undefined && !isRunning) {
      inspectorExitPill.hidden = false
      inspectorExitPill.textContent = `exit ${target.exitCode}`
      inspectorExitPill.dataset.tone = target.exitCode === 0 ? "success" : "error"
    } else {
      inspectorExitPill.hidden = true
    }

    if (target.restartCount > 0) {
      inspectorRestartPill.hidden = false
      inspectorRestartPill.textContent = `重启 ×${target.restartCount}`
    } else {
      inspectorRestartPill.hidden = true
    }

    const src = sourceLabel(target.source)
    if (src) {
      inspectorSourcePill.hidden = false
      inspectorSourcePill.textContent = src
    } else {
      inspectorSourcePill.hidden = true
    }

    if (isRunning) {
      inspPrimaryNode.hidden = false
      inspPrimaryBtn.update({
        label: target.role === "build" ? "重新运行" : "重启",
        variant: "outline",
        loading: busyActions.has(`${target.id}:restart`),
        disabled: anyBusy,
      })
      inspStopNode.hidden = false
      inspStopBtn.update({
        loading: busyActions.has(`${target.id}:stop`),
        disabled: anyBusy,
      })
      inspForceNode.hidden = false
      inspForceBtn.update({
        variant: stopTimedOutIds.has(target.id) ? "destructive" : "outline",
        loading: busyActions.has(`${target.id}:force`),
        disabled: anyBusy,
      })
    } else {
      inspPrimaryNode.hidden = false
      inspPrimaryBtn.update({
        label: target.role === "build" ? "重试" : "启动",
        variant: target.status === "failed" ? "default" : "outline",
        loading: busyActions.has(`${target.id}:restart`),
        disabled: anyBusy,
      })
      inspStopNode.hidden = true
      inspForceNode.hidden = true
    }

    inspRemoveNode.hidden = false
    inspRemoveBtn.update({
      loading: removing,
      disabled: anyBusy,
    })

    inspConfirmBar.hidden = !confirmingRemove
    if (confirmingRemove) {
      inspConfirmBar.dataset.running = isRunning ? "true" : "false"
      inspConfirmText.textContent = isRunning
        ? "该任务正在运行，终止并移除将销毁终端窗格并删除记录。"
        : `确认移除任务「${target.name}」的记录？`
      inspConfirmCancelBtn.update({ disabled: anyBusy })
      inspConfirmOkBtn.update({
        label: isRunning ? "终止并移除" : "确认移除",
        loading: removing,
        disabled: anyBusy,
      })
    }

    inspectorCmdEl.textContent = `$ ${target.command}`

    metaGridEl.textContent = ""
    const items: Array<[string, string]> = [
      ["目录", target.cwd],
      ["会话", `${target.muxSession} (${target.paneId})`],
      ["更新", formatRelativeTime(target.updatedAt)],
    ]
    for (const [k, v] of items) {
      const item = document.createElement("span")
      item.className = "mux-meta-item"
      const keyEl = document.createElement("span")
      keyEl.textContent = `${k}:`
      const valEl = document.createElement("span")
      valEl.className = "mux-meta-value mux-mono"
      valEl.textContent = v
      valEl.title = v
      item.append(keyEl, valEl)
      metaGridEl.append(item)
    }

    attachChipBtn.hidden = !attachable
    if (attachable) {
      attachChipCmd.textContent = target.attachCommand
      attachChipBtn.title = `点击复制: ${target.attachCommand}`
    }

    refreshLogsBtn.update({
      loading: logLoading,
      disabled: !attachable,
    })

    if (!attachable) {
      logViewport.setContent("", {
        emptyText: "终端窗格已销毁，无法读取实时日志。点击上方「重试 / 启动」可重新创建终端。",
      })
    } else if (lastLogTaskId === target.id && lastLogError) {
      logViewport.setContent("", { emptyText: lastLogError, isError: true })
    } else if (lastLogTaskId === target.id) {
      logViewport.setContent(lastLogText, {
        emptyText: logLoading ? "正在读取终端输出..." : "暂无输出日志",
      })
    } else {
      logViewport.setContent("", { emptyText: "正在读取终端输出..." })
    }

    // 标准输入栏：仅在运行中显示，且绝不覆盖用户正在输入的草稿
    stdinBar.hidden = !isRunning
    if (isRunning) {
      const draft = stdinDrafts.get(target.id) ?? ""
      stdinField.update({
        value: draft,
        disabled: busyActions.has(`${target.id}:input`),
      })
      sendStdinBtn.update({
        loading: busyActions.has(`${target.id}:input`),
      })
    }
  }

  function render(): void {
    const sortedAll = sortTasks(tasks)
    const counts = summarizeTasks(sortedAll)

    // 顶部后端状态与作用域切换
    if (backend === undefined) {
      backendBadge.update({ label: "检测中", tone: "neutral" })
    } else if (backend === null) {
      backendBadge.update({ label: "未检测到后端", tone: "warning" })
    } else {
      backendBadge.update({ label: backendLabel(backend), tone: "info" })
    }

    scopeWrap.hidden = currentDirectory === null
    scopeProjectBtn.setAttribute("aria-pressed", scope === "project" ? "true" : "false")
    scopeAllBtn.setAttribute("aria-pressed", scope === "all" ? "true" : "false")

    cleanHistoryBtnNode.hidden = currentDirectory === null
    if (currentDirectory !== null) {
      cleanHistoryBtn.update({
        label: scope === "project" ? "清理历史" : "清理本项目历史",
        disabled: backend === null,
      })
      cleanHistoryBtnNode.title =
        scope === "project"
          ? "清理失效记录及超过 7 天的已结束任务"
          : `仅清理当前项目：${currentDirectory}`
    }
    refreshBtn.update({ loading: refreshing })

    renderLauncher()

    // 过滤计数与标签
    filterTabs.update({
      activeId: roleFilter,
      items: [
        { id: "all", label: "全部", count: counts.total },
        { id: "build", label: "构建", count: counts.builds },
        { id: "service", label: "后台服务", count: counts.services },
      ],
    })

    summaryPillsEl.textContent = ""
    if (counts.running > 0) {
      const p = document.createElement("span")
      p.className = "mux-pill mux-num"
      p.dataset.tone = "info"
      const d = document.createElement("span")
      d.className = "mux-dot"
      d.dataset.status = "running"
      p.append(d, `${counts.running} 运行中`)
      summaryPillsEl.append(p)
    }
    if (counts.failed > 0) {
      const p = document.createElement("span")
      p.className = "mux-pill mux-num"
      p.dataset.tone = "error"
      p.textContent = `${counts.failed} 失败`
      summaryPillsEl.append(p)
    }

    if (lastError) {
      setBanner({
        tone: lastError.setupRequired ? "warning" : "error",
        title: lastError.title,
        body: lastError.detail,
        action: {
          label: "重试连接",
          onClick: () => {
            void poller.triggerNow()
          },
        },
      })
    } else if (backend === null) {
      setBanner({
        tone: "warning",
        title: "未检测到 tmux 或 psmux",
        body: "请在系统 PATH 中安装 tmux（Linux/macOS）或 psmux（Windows）后点击重新检测。",
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

    if (initialLoading && sortedAll.length === 0 && !lastError) {
      loadingSlot.hidden = false
      workspaceEl.hidden = true
      setGlobalEmpty(null)
      renderCloseDialog()
      return
    }
    loadingSlot.hidden = true

    const visibleTasks =
      roleFilter === "all" ? sortedAll : sortedAll.filter((t) => t.role === roleFilter)

    // 选中项失效时自动回退到当前可见首条任务
    if (visibleTasks.length > 0 && (!selectedTaskId || !visibleTasks.some((t) => t.id === selectedTaskId))) {
      const prevId = selectedTaskId
      selectedTaskId = visibleTasks[0].id
      if (prevId !== selectedTaskId) {
        inspConfirmRemoveTaskId = null
        lastLogTaskId = null
        lastLogText = ""
        lastLogError = ""
        logViewport.resetPin()
        if (isAttachable(visibleTasks[0])) {
          void fetchSelectedLogs(visibleTasks[0].id)
        }
      }
    } else if (visibleTasks.length === 0) {
      selectedTaskId = null
      inspConfirmRemoveTaskId = null
    }

    if (visibleTasks.length === 0) {
      for (const ctrl of cardControllers.values()) ctrl.dispose()
      cardControllers.clear()
      for (const ctrl of groupControllers.values()) ctrl.dispose()
      groupControllers.clear()
      workspaceEl.hidden = true
      if (!lastError && backend !== null) {
        const emptyTitle =
          sortedAll.length === 0
            ? scope === "project" && currentDirectory
              ? "当前项目暂无 Mux 任务"
              : "暂无 Mux 任务"
            : `暂无${roleFilter === "build" ? "构建" : "后台服务"}任务`
        setGlobalEmpty({
          title: emptyTitle,
          body: "AI 触发的构建与后台服务会出现在这里；你也可以手动创建并管理任务。",
          action: {
            label: "+ 新建任务",
            onClick: () => {
              launcherOpen = true
              render()
            },
          },
        })
      } else {
        setGlobalEmpty(null)
      }
      renderCloseDialog()
      return
    }

    setGlobalEmpty(null)
    workspaceEl.hidden = false

    // 按 muxSession 分组并增量同步组头与卡片 DOM，保留焦点与确认状态
    const groups = groupVisibleTasks(sortedAll, visibleTasks)
    const activeSessions = new Set(groups.map((g) => g.muxSession))
    const visibleIds = new Set(visibleTasks.map((t) => t.id))

    for (const [id, ctrl] of cardControllers) {
      if (!visibleIds.has(id)) {
        ctrl.dispose()
        cardControllers.delete(id)
      }
    }
    for (const [sessionName, gCtrl] of groupControllers) {
      if (!activeSessions.has(sessionName)) {
        gCtrl.dispose()
        groupControllers.delete(sessionName)
      }
    }

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const group = groups[gIdx]
      let gCtrl = groupControllers.get(group.muxSession)
      if (!gCtrl) {
        gCtrl = createGroupController(group)
        groupControllers.set(group.muxSession, gCtrl)
      } else {
        gCtrl.update(group)
      }

      for (let tIdx = 0; tIdx < group.visibleTasks.length; tIdx++) {
        const task = group.visibleTasks[tIdx]
        const isSelected = task.id === selectedTaskId
        let ctrl = cardControllers.get(task.id)
        if (!ctrl) {
          ctrl = createCardController(task)
          cardControllers.set(task.id, ctrl)
        } else {
          ctrl.update(task, isSelected)
        }
        const existingCard = gCtrl.cardsContainer.children[tIdx]
        if (existingCard !== ctrl.element) {
          gCtrl.cardsContainer.insertBefore(ctrl.element, existingCard ?? null)
        }
      }

      const existingGroup = listPane.children[gIdx]
      if (existingGroup !== gCtrl.element) {
        listPane.insertBefore(gCtrl.element, existingGroup ?? null)
      }
    }

    renderInspector()
    renderCloseDialog()
  }

  // --- 自适应轮询 ---
  const poller = createPoller({
    getIntervalMs: () => {
      if (lastError?.setupRequired) return 6000
      const selected = getSelectedTask()
      if ((selected && selected.status === "running") || tasks.some((t) => t.status === "running")) {
        return 1600
      }
      return 4500
    },
    run: async ({ stale }) => {
      refreshing = true
      render()
      try {
        const queryCwd = scope === "project" && currentDirectory ? currentDirectory : undefined
        const res = await client.listTasks(queryCwd ? { cwd: queryCwd } : undefined)
        if (stale()) return
        backend = res.backend
        tasks = res.tasks
        lastError = null
        for (const t of tasks) {
          if (t.status !== "running") stopTimedOutIds.delete(t.id)
        }
        if (confirmRemoveTaskId && !tasks.some((t) => t.id === confirmRemoveTaskId)) {
          confirmRemoveTaskId = null
        }
        if (inspConfirmRemoveTaskId && !tasks.some((t) => t.id === inspConfirmRemoveTaskId)) {
          inspConfirmRemoveTaskId = null
        }

        // 若当前选中任务是首条自动选中或已选中且开启自动刷新，同步读取其最新日志
        const sorted = sortTasks(tasks)
        const visible = roleFilter === "all" ? sorted : sorted.filter((t) => t.role === roleFilter)
        if (visible.length > 0 && (!selectedTaskId || !visible.some((t) => t.id === selectedTaskId))) {
          selectedTaskId = visible[0].id
          lastLogTaskId = null
          logViewport.resetPin()
        }

        const target = getSelectedTask()
        if (target && isAttachable(target) && (autoRefreshLogs || lastLogTaskId !== target.id)) {
          try {
            const logs = await client.getLogs(target.id, logLines)
            if (stale()) return
            lastLogTaskId = target.id
            lastLogText = logs.tail
            lastLogError = ""
          } catch (logError) {
            if (!stale()) {
              lastLogTaskId = target.id
              lastLogText = ""
              lastLogError = formatClientError(logError).detail
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

  function syncProjectDirectory(nextDir: string | null, shouldTrigger = true): void {
    const normalized = nextDir && nextDir.trim() ? nextDir : null
    const changed = normalized !== currentDirectory
    currentDirectory = normalized
    if (!draftCwdTouched) {
      draftCwd = normalized ?? ""
      cwdField.update({ value: draftCwd })
    }
    if (normalized === null && scope === "project") {
      scope = "all"
    }
    if (changed) {
      historyController.onDirectoryChange(normalized)
      render()
      if (shouldTrigger) void poller.triggerNow({ invalidate: true })
    }
  }

  let started = false
  host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    syncProjectDirectory(ctx.directory, started)
    if (!started) {
      started = true
      poller.start()
    }
  })

  host.onDirectory((directory) => {
    syncProjectDirectory(directory)
  })

  window.addEventListener("beforeunload", () => {
    window.removeEventListener("keydown", handleGlobalKeydown)
    poller.dispose()
    backendBadge.dispose()
    cleanHistoryBtn.dispose()
    toggleLauncherBtn.dispose()
    refreshBtn.dispose()
    nameField.dispose()
    cmdField.dispose()
    cwdField.dispose()
    cancelLaunchBtn.dispose()
    submitLaunchBtn.dispose()
    filterTabs.dispose()
    spinner.dispose()
    bannerHandle?.dispose()
    globalEmptyHandle?.dispose()
    inspectorEmptyHandle?.dispose()
    inspectorStatusBadge.dispose()
    inspPrimaryBtn.dispose()
    inspStopBtn.dispose()
    inspForceBtn.dispose()
    inspRemoveBtn.dispose()
    inspConfirmCancelBtn.dispose()
    inspConfirmOkBtn.dispose()
    closeDialogCancelBtn.dispose()
    closeDialogConfirmBtn.dispose()
    historyIncludeShellCheck.dispose()
    historySpinner.dispose()
    historyCancelBtn.dispose()
    historyRetryBtn.dispose()
    historyConfirmBtn.dispose()
    linesSelect.dispose()
    autoRefreshSwitch.dispose()
    refreshLogsBtn.dispose()
    copyLogsBtn.dispose()
    stdinField.dispose()
    stdinEnterCheck.dispose()
    sendStdinBtn.dispose()
    logViewport.dispose()
    for (const ctrl of cardControllers.values()) ctrl.dispose()
    cardControllers.clear()
    for (const gCtrl of groupControllers.values()) gCtrl.dispose()
    groupControllers.clear()
    host.dispose()
  })

  render()
}
