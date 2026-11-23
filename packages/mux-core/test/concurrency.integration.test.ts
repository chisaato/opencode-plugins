import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { createCommandRunner, createMuxClient, createMuxManager, createMuxState, MuxError, withStateLock } from "../src"
import type { CommandRunner } from "../src"

const tmuxAvailable = !spawnSync("tmux", ["-V"]).error
const bunAvailable = !spawnSync("bun", ["--version"]).error
const managerOptions = { byobuKeys: false, keepShellOnExit: false, statusTheme: "off" } as const

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function isolatedMux(work: (fixture: {
  dir: string
  backend: { kind: "tmux"; socketName: string }
  runner: CommandRunner
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "oc-mux-concurrency-"))
  const backend = { kind: "tmux", socketName: "mux-concurrency" } as const
  const run = createCommandRunner()
  const runner: CommandRunner = (file, args, options) => {
    if (file !== "tmux" || args[0] !== "-L" || args[1] !== backend.socketName) {
      throw new Error("Integration tests may only access the isolated tmux server")
    }
    return run(file, ["-f", "/dev/null", ...args], {
      ...options, env: { ...process.env, ...options?.env, HOME: dir, XDG_CONFIG_HOME: dir, TMUX_TMPDIR: dir, TMUX: undefined },
    })
  }
  try {
    await work({ dir, backend, runner })
  } finally {
    try {
      await runner("tmux", ["-L", backend.socketName, "kill-server"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

describe.skipIf(!tmuxAvailable)("real tmux manager concurrency", () => {
  it("reuses one task and one pane when two managers start the same service", async () => {
    await isolatedMux(async ({ dir, backend, runner }) => {
      const firstListed = deferred()
      const continueFirst = deferred()
      const secondListed = deferred()
      let firstQuery = true
      const firstRunner: CommandRunner = async (...args) => {
        const result = await runner(...args)
        if (args[1][2] === "list-panes" && firstQuery) {
          firstQuery = false
          firstListed.resolve()
          await continueFirst.promise
        }
        return result
      }
      const secondRunner: CommandRunner = async (...args) => {
        const result = await runner(...args)
        if (args[1][2] === "list-panes") secondListed.resolve()
        return result
      }
      const common = { ...managerOptions, stateDir: dir, backend }
      const a = createMuxManager({ ...common, runner: firstRunner })
      const b = createMuxManager({ ...common, runner: secondRunner })
      const input = { action: "start", name: "same-service", cwd: dir, command: "sleep 60" } as const
      const first = a.serviceAction(input)
      await Promise.race([firstListed.promise, first])
      const second = b.serviceAction(input)
      // 正确加锁时第二次查询不会进入，始终允许第一方继续，不等待双方同时到达屏障。
      const enteredEarly = await Promise.race([
        secondListed.promise.then(() => true),
        delay(200, false),
      ])
      continueFirst.resolve()
      const [one, two] = await Promise.all([first, second])
      expect(one).toMatchObject({ ok: true, task: { status: "running" } })
      expect(two.task?.id).toBe(one.task?.id)
      expect(enteredEarly).toBe(false)
      expect(await createMuxClient(backend, runner).listPanes()).toMatchObject([{ taskId: one.task?.id }])
      expect(await createMuxState(dir).listTasks()).toMatchObject([{ id: one.task?.id }])
    })
  })

  it("allows short writes on the same manager while a build poll and capture are paused", async () => {
    await isolatedMux(async ({ dir, backend, runner }) => {
      const pollGate = deferred()
      const captureGate = deferred()
      let waitingForBuild = false
      let pausedPoll = false
      let pausedCapture = false
      const slowRunner: CommandRunner = async (...args) => {
        const argsList = args[1]
        const command = argsList[2]
        if (command === "wait-for") waitingForBuild = true
        if (command === "list-panes" && waitingForBuild && !pausedPoll) {
          pausedPoll = true
          await pollGate.promise
        }
        if (command === "capture-pane" && !pausedCapture) {
          pausedCapture = true
          await captureGate.promise
        }
        return runner(...args)
      }
      const manager = createMuxManager({ ...managerOptions, stateDir: dir, backend, runner: slowRunner, pollIntervalMs: 10 })
      const build = manager.runBuild({ cwd: dir, name: "long build", command: "sleep 60", timeoutMs: 2_000 })
      void build.catch(() => {})
      let capture: Promise<string> | undefined
      let write: ReturnType<typeof manager.serviceAction> | undefined
      try {
        await vi.waitFor(() => expect(pausedPoll).toBe(true))
        const [task] = await createMuxState(dir).listTasks()
        capture = manager.captureLogs(task.id)
        void capture.catch(() => {})
        await vi.waitFor(() => expect(pausedCapture).toBe(true))

        let written = false
        write = manager.serviceAction({ cwd: dir, name: "short write", action: "start", command: "sleep 60" })
        void write.then(() => { written = true }, () => {})
        await vi.waitFor(() => expect(written).toBe(true))
        expect(await write).toMatchObject({ ok: true, task: { status: "running" } })
        await manager.removeTask(task.id)
        pollGate.resolve()
        captureGate.resolve()
        await expect(build).resolves.toMatchObject({ ok: false, task: { status: "gone" } })
        await expect(capture).rejects.toMatchObject({ code: "TASK_NO_LIVE_PANE" })
        expect(await createMuxState(dir).readTask(task.id)).toBeUndefined()
      } finally {
        pollGate.resolve()
        captureGate.resolve()
        await Promise.allSettled([build, capture, write])
      }
    })
  })

  it("rechecks the generation before force-stopping after a concurrent restart", async () => {
    await isolatedMux(async ({ dir, backend, runner }) => {
      const stalePoll = deferred()
      let interrupted = false
      let pausedPoll = false
      let killCalls = 0
      const stopRunner: CommandRunner = async (...args) => {
        const result = await runner(...args)
        const cli = args[1]
        if (cli[2] === "send-keys" && cli.at(-1) === "C-c") interrupted = true
        if (cli[2] === "kill-pane") killCalls++
        if (cli[2] === "list-panes" && interrupted && !pausedPoll) {
          pausedPoll = true
          await stalePoll.promise
        }
        return result
      }
      const manager = createMuxManager({ ...managerOptions, stateDir: dir, backend, runner: stopRunner })
      const started = await manager.serviceAction({
        cwd: dir, name: "restart while stopping", action: "start",
        command: "trap '' INT; printf 'ready\\n'; exec sleep 60",
      })
      const { id, paneId } = started.task!
      await vi.waitFor(async () => expect(await manager.captureLogs(id)).toContain("ready"))
      const stopping = manager.stopTask(id, { timeoutMs: 120, force: true })
      void stopping.catch(() => {})
      let restarting: ReturnType<typeof manager.restartTask> | undefined
      try {
        await vi.waitFor(() => expect(pausedPoll).toBe(true))
        let restarted = false
        restarting = manager.restartTask(id, { command: "sleep 60" })
        void restarting.then(() => { restarted = true }, () => {})
        await vi.waitFor(() => expect(restarted).toBe(true))
        expect(await restarting).toMatchObject({ ok: true, task: { id, paneId, restartCount: 1, status: "running" } })
        // 让旧查询在超时后返回重启前的快照，迫使强停路径重新取锁校验代次。
        await delay(120)
        stalePoll.resolve()
        expect(await stopping).toMatchObject({ ok: false, task: { id, paneId, restartCount: 1, status: "running" } })
        expect(killCalls).toBe(0)
        expect(await createMuxClient(backend, runner).listPanes()).toMatchObject([{ paneId, taskId: id, paneDead: false }])
        expect(await createMuxState(dir).readTask(id)).toMatchObject({ restartCount: 1, status: "running" })
      } finally {
        stalePoll.resolve()
        await Promise.allSettled([stopping, restarting])
      }
    })
  })
})

describe("SQLite state lock", () => {
  it.skipIf(!bunAvailable || process.platform === "win32")("lets two waiters enter after a Bun lock holder is killed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-mux-killed-lock-"))
    const module = fileURLToPath(new URL("../src/lock.ts", import.meta.url))
    const child = spawn("bun", ["-e", `
      const { withStateLock } = await import(process.argv[1])
      await withStateLock(process.argv[2], () => {
        console.log("locked")
        return new Promise(() => setInterval(() => {}, 1000))
      })
    `, module, dir], { stdio: ["ignore", "pipe", "pipe"] })
    const exited = once(child, "exit")
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    const waiters: Promise<void>[] = []
    const entered: number[] = []
    let active = 0
    try {
      await vi.waitFor(() => expect(stdout, stderr).toContain("locked\n"))
      for (const index of [1, 2]) {
        waiters.push(withStateLock(dir, async () => {
          expect(active++).toBe(0)
          entered.push(index)
          await delay(50)
          active--
        }))
      }
      await delay(100)
      expect(entered).toEqual([])
      expect(child.kill("SIGKILL")).toBe(true)
      expect(await exited).toEqual([null, "SIGKILL"])
      await Promise.all(waiters)
      expect(entered.sort()).toEqual([1, 2])
    } finally {
      child.kill("SIGKILL")
      await Promise.allSettled([exited, ...waiters])
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("gives up with STATE_BUSY without blocking the event loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-mux-busy-lock-"))
    const gate = deferred()
    const acquired = deferred()
    const holder = withStateLock(dir, () => { acquired.resolve(); return gate.promise })
    let contender: Promise<unknown> | undefined
    try {
      await Promise.race([acquired.promise, holder])
      const work = vi.fn()
      contender = withStateLock(dir, work)
      const rejection = expect(contender).rejects.toMatchObject({ code: "STATE_BUSY" })
      const started = performance.now()
      // 竞争者重试期间事件循环仍然可用（未同步阻塞）。
      await delay(20)
      await rejection
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(4_000)
      expect(elapsed).toBeLessThan(8_000)
      await expect(contender).rejects.toBeInstanceOf(MuxError)
      expect(work).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await Promise.allSettled([holder, contender])
      await rm(dir, { recursive: true, force: true })
    }
  }, 8_000)
})
