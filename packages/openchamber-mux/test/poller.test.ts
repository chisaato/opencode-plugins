import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPoller } from "../src/ui/poller"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("轮询生命周期", () => {
  let page: EventTarget & { visibilityState: DocumentVisibilityState }

  beforeEach(() => {
    vi.useFakeTimers()
    page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState })
    vi.stubGlobal("document", page)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function setVisibility(state: DocumentVisibilityState) {
    page.visibilityState = state
    page.dispatchEvent(new Event("visibilitychange"))
  }

  it("切换项目时拒绝旧结果，只发一次合并刷新并等待该次刷新", async () => {
    const oldRequest = deferred()
    const newRequest = deferred()
    let cwd = "/project/A"
    const requested: string[] = []
    const committed: string[] = []
    const poller = createPoller({
      getIntervalMs: () => 1000,
      run: async ({ stale }) => {
        const requestCwd = cwd
        requested.push(requestCwd)
        await (requestCwd === "/project/A" ? oldRequest : newRequest).promise
        if (!stale()) committed.push(requestCwd)
      },
    })

    const first = poller.triggerNow()
    cwd = "/project/B"
    const switched = poller.triggerNow({ invalidate: true })
    const manual = poller.triggerNow()
    const done = vi.fn()
    void Promise.all([switched, manual]).then(done)
    expect(requested).toEqual(["/project/A"])

    oldRequest.resolve()
    await first
    expect(committed).toEqual([])
    expect(requested).toEqual(["/project/A", "/project/B"])
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).not.toHaveBeenCalled()
    expect(requested).toEqual(["/project/A", "/project/B"])

    newRequest.resolve()
    await Promise.all([switched, manual])
    expect(committed).toEqual(["/project/B"])
    expect(done).toHaveBeenCalledOnce()
    poller.dispose()
  })

  it("普通刷新不废弃在途结果，dispose 废弃在途结果且取消排队", async () => {
    const firstRequest = deferred()
    const secondRequest = deferred()
    const committed = vi.fn()
    const run = vi.fn(async ({ stale }: { stale: () => boolean }) => {
      const index = run.mock.calls.length
      await (index === 1 ? firstRequest : secondRequest).promise
      if (!stale()) committed(index)
    })
    const poller = createPoller({ run, getIntervalMs: () => 1000 })

    const first = poller.triggerNow()
    const second = poller.triggerNow()
    firstRequest.resolve()
    await first
    expect(committed).toHaveBeenCalledExactlyOnceWith(1)
    expect(run).toHaveBeenCalledTimes(2)

    const cancelled = poller.triggerNow()
    poller.dispose()
    secondRequest.resolve()
    await Promise.all([second, cancelled, poller.triggerNow()])
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(1000)
    expect(committed).toHaveBeenCalledExactlyOnceWith(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("隐藏时不续跑排队的可见刷新，但允许显式刷新", async () => {
    const request = deferred()
    const run = vi.fn().mockImplementationOnce(() => request.promise).mockResolvedValue(undefined)
    const poller = createPoller({ run, getIntervalMs: () => 1000 })

    const first = poller.triggerNow()
    setVisibility("hidden")
    setVisibility("visible")
    setVisibility("hidden")
    request.resolve()
    await first
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)

    await poller.triggerNow()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)

    setVisibility("visible")
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(4)
    poller.dispose()
  })
})
