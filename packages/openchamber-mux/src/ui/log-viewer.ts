import { cleanTerminalOutput } from "./ansi"

export interface LogViewport {
  element: HTMLElement
  setContent: (rawText: string, options?: { emptyText?: string; isError?: boolean }) => void
  scrollToBottom: () => void
  resetPin: () => void
  getText: () => string
  dispose: () => void
}

const BOTTOM_THRESHOLD_PX = 28

/**
 * 可保持滚动位置的终端日志视口：
 * - 用户处于底部时自动随新日志滚动到底部
 * - 用户上滑阅读历史输出时锁定当前 scrollTop，不被后台轮询打断
 */
export function createLogViewport(options: { compact?: boolean } = {}): LogViewport {
  const wrapper = document.createElement("div")
  wrapper.className = options.compact ? "mux-log-box mux-log-box--compact" : "mux-log-box"

  const scrollArea = document.createElement("div")
  scrollArea.className = "mux-log-scroll"

  const pre = document.createElement("pre")
  pre.className = "mux-log-pre"

  const emptyEl = document.createElement("div")
  emptyEl.className = "mux-log-empty"
  emptyEl.hidden = true

  const jumpBtn = document.createElement("button")
  jumpBtn.type = "button"
  jumpBtn.className = "mux-log-jump"
  jumpBtn.textContent = "↓ 回到底部"
  jumpBtn.hidden = true

  scrollArea.append(pre, emptyEl)
  wrapper.append(scrollArea, jumpBtn)

  let pinnedToBottom = true
  let lastCleanText = ""
  let lastEmptyText = ""
  let ignoreScroll = false

  function isNearBottom(): boolean {
    const gap = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop
    return gap <= BOTTOM_THRESHOLD_PX
  }

  function updateJumpButton(): void {
    jumpBtn.hidden = pinnedToBottom || !lastCleanText
  }

  function scrollToBottom(): void {
    ignoreScroll = true
    scrollArea.scrollTop = scrollArea.scrollHeight
    pinnedToBottom = true
    updateJumpButton()
    requestAnimationFrame(() => {
      ignoreScroll = false
    })
  }

  const onScroll = () => {
    if (ignoreScroll) return
    pinnedToBottom = isNearBottom()
    updateJumpButton()
  }

  const onJumpClick = () => {
    scrollToBottom()
  }

  scrollArea.addEventListener("scroll", onScroll, { passive: true })
  jumpBtn.addEventListener("click", onJumpClick)

  return {
    element: wrapper,
    setContent: (rawText, opts = {}) => {
      const cleaned = cleanTerminalOutput(rawText).replace(/\n+$/, "")
      const emptyText = opts.emptyText ?? "暂无输出日志"
      wrapper.dataset.error = opts.isError ? "true" : "false"

      if (!cleaned) {
        if (lastCleanText !== "" || lastEmptyText !== emptyText || pre.hidden === false) {
          lastCleanText = ""
          lastEmptyText = emptyText
          pre.textContent = ""
          pre.hidden = true
          emptyEl.textContent = emptyText
          emptyEl.hidden = false
          updateJumpButton()
        }
        return
      }

      if (cleaned === lastCleanText && !pre.hidden) {
        updateJumpButton()
        return
      }

      const prevTop = scrollArea.scrollTop
      lastCleanText = cleaned
      lastEmptyText = ""
      emptyEl.hidden = true
      pre.hidden = false
      pre.textContent = cleaned

      if (pinnedToBottom) {
        scrollToBottom()
      } else {
        ignoreScroll = true
        scrollArea.scrollTop = prevTop
        updateJumpButton()
        requestAnimationFrame(() => {
          ignoreScroll = false
        })
      }
    },
    scrollToBottom,
    resetPin: () => {
      pinnedToBottom = true
      lastCleanText = ""
      updateJumpButton()
    },
    getText: () => lastCleanText,
    dispose: () => {
      scrollArea.removeEventListener("scroll", onScroll)
      jumpBtn.removeEventListener("click", onJumpClick)
    },
  }
}
