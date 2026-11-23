export interface PollerOptions {
  run: (signal: { stale: () => boolean }) => Promise<void>
  getIntervalMs: () => number
  onVisibilityShow?: () => void
}

export interface Poller {
  start: () => void
  triggerNow: (options?: { invalidate?: boolean }) => Promise<void>
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
  let queued: { explicit: boolean; promise: Promise<void> } | null = null

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

  async function tick(explicit = false): Promise<void> {
    if (disposed || (!explicit && document.visibilityState === "hidden")) return
    if (queued) {
      queued.explicit ||= explicit
      return queued.promise
    }
    if (inFlight) {
      // 并发触发共享下一次刷新，等待的是该刷新而非正在执行的请求。
      const runQueued = (): Promise<void> => {
        queued = null
        return tick(next.explicit)
      }
      const next = { explicit, promise: inFlight.then(runQueued, runQueued) }
      queued = next
      return next.promise
    }
    clearTimer()
    const currentSeq = seq
    const stale = () => disposed || currentSeq !== seq
    inFlight = options.run({ stale }).finally(() => {
      inFlight = null
      if (!queued) scheduleNext()
    })
    return inFlight
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
    triggerNow: ({ invalidate = false } = {}) => {
      // 仅查询范围等变化会废弃在途结果；普通刷新仍可提交。
      if (invalidate) seq += 1
      return tick(true)
    },
    dispose: () => {
      disposed = true
      clearTimer()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    },
  }
}
