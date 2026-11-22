export interface PollerOptions {
  run: (signal: { stale: () => boolean }) => Promise<void>
  getIntervalMs: () => number
  onVisibilityShow?: () => void
}

export interface Poller {
  start: () => void
  triggerNow: () => Promise<void>
  dispose: () => void
}

/**
 * 自适应轮询控制器：
 * - 页面隐藏时暂停后台轮询，切回可见时立即刷新
 * - 并发安全，使用序号防止过期响应回写状态
 */
export function createPoller(options: PollerOptions): Poller {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  let inFlight: Promise<void> | null = null
  let pendingTrigger = false

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleNext(): void {
    clearTimer()
    if (disposed || document.visibilityState === "hidden") return
    const delay = Math.max(600, options.getIntervalMs())
    timer = setTimeout(() => {
      void tick()
    }, delay)
  }

  async function tick(): Promise<void> {
    if (disposed) return
    if (inFlight) {
      pendingTrigger = true
      await inFlight
      return
    }
    clearTimer()
    const currentSeq = ++seq
    const stale = () => disposed || currentSeq !== seq
    const runPromise = options.run({ stale }).finally(() => {
      if (inFlight === runPromise) inFlight = null
    })
    inFlight = runPromise
    try {
      await runPromise
    } finally {
      if (!disposed) {
        if (pendingTrigger) {
          pendingTrigger = false
          void tick()
        } else {
          scheduleNext()
        }
      }
    }
  }

  const onVisibilityChange = () => {
    if (disposed) return
    if (document.visibilityState === "hidden") {
      clearTimer()
    } else {
      options.onVisibilityShow?.()
      void tick()
    }
  }

  document.addEventListener("visibilitychange", onVisibilityChange)

  return {
    start: () => {
      if (disposed) return
      void tick()
    },
    triggerNow: () => tick(),
    dispose: () => {
      disposed = true
      seq += 1
      clearTimer()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    },
  }
}
