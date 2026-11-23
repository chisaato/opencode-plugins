import { createHash, randomUUID } from "node:crypto"
import { basename, resolve } from "node:path"
import { buildAttachCommand, createCommandRunner, detectMuxBackend, supportsPosixMuxFeatures } from "./backend"
import { MuxError } from "./errors"
import { withStateLock } from "./lock"
import { createMuxState, isSafeTaskId } from "./state"
import { createMuxClient } from "./tmux"
import type {
  LivePaneInfo, ManagedPaneOptions, ManagedTask, MuxBackend, MuxManagerOptions,
  RestartTaskOptions, RunBuildOptions, RunBuildResult, SendInputOptions, ServiceActionOptions,
  ServiceActionResult, StopTaskOptions, TaskFilter, TaskIdentity, TaskRole,
} from "./types"

const now = () => new Date().toISOString()
const noLivePane = (id: string) => new MuxError("TASK_NO_LIVE_PANE", `Mux task ${id} has no live pane`)

export function projectMuxSession(cwd: string): string {
  const directory = resolve(cwd)
  const slug = basename(directory).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40).replace(/^-+|-+$/g, "") || "project"
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 8)
  return `oc-${slug}-${hash}`
}

function duration(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from ${min} to 2147483647`)
  }
  return value
}

function validateCommand(command: string): void {
  if (!command.trim() || command.includes("\0")) throw new Error("A non-empty mux command is required")
}

function statusFromPane(pane: LivePaneInfo, exitCode?: number, stopRequested = false): ManagedTask["status"] {
  if (exitCode !== undefined) return exitCode === 0 ? "succeeded" : exitCode >= 128 ? "stopped" : "failed"
  if (!pane.paneDead) return "running"
  if (stopRequested && (pane.exitCode === undefined || [0, 130, 143].includes(pane.exitCode))) return "stopped"
  return pane.exitCode === 0 ? "succeeded" : "failed"
}

function matches(task: ManagedTask, filter: TaskFilter): boolean {
  return (filter.cwd === undefined || task.cwd === resolve(filter.cwd))
    && (filter.role === undefined || task.role === filter.role)
    && (filter.name === undefined || task.name === filter.name)
    && (filter.status === undefined || task.status === filter.status)
    && (filter.sessionId === undefined || task.sessionId === filter.sessionId)
}

const delay = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms) })

function sameRun(a: ManagedTask, b: ManagedTask): boolean {
  return a.id === b.id && a.paneId === b.paneId && a.panePid === b.panePid && a.restartCount === b.restartCount
}

export function createMuxManager(options: MuxManagerOptions = {}) {
  const runner = options.runner ?? createCommandRunner()
  const state = createMuxState(options.stateDir)
  const polling = duration(options.pollIntervalMs ?? 100, "pollIntervalMs", 1)
  let backendPromise: Promise<MuxBackend> | undefined
  function getBackend(): Promise<MuxBackend> {
    if (options.backend) return Promise.resolve({
      ...options.backend,
      platform: options.platform ?? options.backend.platform,
      socketName: options.socketName ?? options.backend.socketName,
    })
    return backendPromise ??= detectMuxBackend({ ...options, runner }).then((backend) => {
      if (!backend) throw new MuxError("BACKEND_UNAVAILABLE", "No tmux or psmux executable found")
      return backend
    }).catch((error) => {
      backendPromise = undefined
      throw error
    })
  }
  const client = async () => {
    const backend = await getBackend()
    return createMuxClient(backend, runner, {
      byobuKeys: options.byobuKeys ?? true,
      statusTheme: options.statusTheme,
      prepareExitFile: options.keepShellOnExit !== false && supportsPosixMuxFeatures(backend) ? state.prepareExitFile : undefined,
    })
  }

  function readExitCode(backend: MuxBackend, pane: LivePaneInfo, id: string, panePid = pane.panePid) {
    return supportsPosixMuxFeatures(backend) ? state.readExitCode({ paneId: pane.paneId, id, panePid }) : undefined
  }

  function paneResult(pane: LivePaneInfo, exitCode?: number, stopRequested?: boolean) {
    return {
      status: statusFromPane(pane, exitCode, stopRequested),
      exitCode: exitCode ?? pane.exitCode,
      shell: !pane.paneDead && exitCode !== undefined ? true as const : undefined,
    }
  }

  // 单个管理器内按入队顺序执行短操作；跨管理器的互斥由状态锁负责。
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work)
    queue = result.catch(() => {})
    return result
  }
  const locked = <T>(work: () => Promise<T>) => serial(() => withStateLock(state.stateDir, work))

  function managedPanes(panes: LivePaneInfo[]) {
    const liveById = new Map<string, LivePaneInfo[]>()
    for (const pane of panes) {
      if (!pane.managed || !pane.taskId || !isSafeTaskId(pane.taskId) || !pane.role) continue
      const current = liveById.get(pane.taskId) ?? []
      if (!current.some(({ paneId }) => paneId === pane.paneId)) current.push(pane)
      liveById.set(pane.taskId, current)
    }
    return liveById
  }

  async function taskSnapshot(backend: MuxBackend, storedTask: ManagedTask | undefined, candidates: LivePaneInfo[]) {
    if (storedTask) {
      if (storedTask.muxKind !== backend.kind || storedTask.socketName !== backend.socketName) return
      // paneId 可在服务重启后复用；必须同时匹配 pane 上的任务标识。
      const pane = candidates.find(({ paneId }) => paneId === storedTask.paneId)
        ?? (candidates.length === 1 ? candidates[0] : undefined)
      const panePid = pane?.panePid ?? (pane?.paneDead && pane.paneId === storedTask.paneId ? storedTask.panePid : undefined)
      const exitCode = pane && await readExitCode(backend, pane, storedTask.id, panePid)
      const restarted = !!pane && (pane.paneId !== storedTask.paneId
        || (pane.panePid !== undefined && storedTask.panePid !== undefined && pane.panePid !== storedTask.panePid)
        || (!pane.paneDead && exitCode === undefined && storedTask.status !== "running"))
      const stopRequested = restarted ? undefined : storedTask.stopRequested
      const task = pane ? {
        ...storedTask,
        muxSession: pane.sessionName,
        paneId: pane.paneId,
        panePid,
        ...paneResult(pane, exitCode, stopRequested),
        stopRequested,
        forceStopped: undefined,
        restartCount: storedTask.restartCount + Number(restarted),
      } : {
        ...storedTask,
        status: (storedTask.forceStopped ? "stopped" : "gone") as ManagedTask["status"],
        shell: undefined,
      }
      return task
    }

    if (candidates.length === 1) {
      const [pane] = candidates
      const id = pane.taskId!
      const timestamp = now()
      const task: ManagedTask = {
        id, role: pane.role!, name: pane.taskName ?? pane.windowName,
        cwd: pane.cwd ?? pane.paneCurrentPath, command: pane.command ?? pane.paneCurrentCommand,
        sessionId: pane.sessionId, muxKind: backend.kind, muxSession: pane.sessionName,
        socketName: backend.socketName, paneId: pane.paneId, panePid: pane.panePid,
        ...paneResult(pane, await readExitCode(backend, pane, id)), restartCount: 0,
        createdAt: timestamp, updatedAt: timestamp,
      }
      return task
    }
  }

  // 必须由持锁调用方提交；不能用锁外读取的快照直接写状态。
  async function writeReconciled(task: ManagedTask, previous?: ManagedTask) {
    if (JSON.stringify(task) === JSON.stringify(previous)) return
    if (previous && task.restartCount !== previous.restartCount && (task.paneId !== previous.paneId
      || (previous.panePid !== undefined && task.panePid !== previous.panePid))) {
      await state.deleteExitFile(previous)
    }
    task.updatedAt = now()
    await state.writeTask(task)
  }

  async function reconcile(): Promise<ManagedTask[]> {
    const backend = await getBackend()
    const [stored, panes] = await Promise.all([state.listTasks(), (await client()).listPanes()])
    const byId = new Map(stored.map((task) => [task.id, task]))
    const liveById = managedPanes(panes)
    const tasks: ManagedTask[] = []
    for (const id of new Set([...byId.keys(), ...liveById.keys()])) {
      const previous = byId.get(id)
      const task = await taskSnapshot(backend, previous, liveById.get(id) ?? [])
      if (!task) continue
      await writeReconciled(task, previous)
      tasks.push(task)
    }
    return tasks
  }

  async function readTaskSnapshot(id: string) {
    if (!isSafeTaskId(id)) return {}
    const backend = await getBackend()
    const previous = await state.readTask(id)
    const panes = await (await client()).listPanes()
    const task = await taskSnapshot(backend, previous, managedPanes(panes.filter((pane) => pane.taskId === id)).get(id) ?? [])
    return { task, previous }
  }

  async function observe(id: string) {
    return (await readTaskSnapshot(id)).task
  }

  async function find(id: string) {
    const { task, previous } = await readTaskSnapshot(id)
    if (task) await writeReconciled(task, previous)
    return task
  }

  async function captureForRun(task: ManagedTask, lines?: number) {
    const mux = await client()
    let tail: string
    try {
      tail = await mux.capturePane(task.paneId, lines)
    } catch (error) {
      const current = await observe(task.id)
      if (current && sameRun(current, task) && current.status !== "gone" && !current.forceStopped) throw error
      return { task: current }
    }
    const current = await observe(task.id)
    // 捕获在锁外；同一 pane 可能已被 respawn，不能把新一轮的日志返回给旧请求。
    return { task: current, tail: current && sameRun(current, task) && current.status !== "gone" && !current.forceStopped ? tail : undefined }
  }

  async function findNamed(role: TaskRole, { name, cwd }: TaskIdentity): Promise<ManagedTask | undefined> {
    return (await reconcile()).filter((t) => t.role === role && t.name === name && t.cwd === cwd)
      .sort((a, b) => Number(a.status === "gone") - Number(b.status === "gone")
        || b.updatedAt.localeCompare(a.updatedAt))[0]
  }

  async function start(
    role: TaskRole, identity: TaskIdentity, command: string, existing?: ManagedTask, channel?: string,
  ): Promise<ManagedTask> {
    validateCommand(command)
    if (!identity.name.trim() || identity.name.includes("\0")) throw new Error("A non-empty mux task name is required")
    const backend = await getBackend()
    const mux = await client()
    const meta: ManagedPaneOptions = {
      ...identity, id: existing?.id ?? randomUUID(), role, command,
      muxSession: existing?.muxSession ?? projectMuxSession(identity.cwd),
      sessionId: identity.sessionId ?? existing?.sessionId, channel,
    }
    const paneAvailable = existing && existing.status !== "gone"
      && (await mux.listPanes()).some((pane) => pane.paneId === existing.paneId && pane.managed && pane.taskId === existing.id)
    if (existing) await state.deleteExitFile(existing)
    let paneId: string
    if (paneAvailable) {
      paneId = existing.paneId
      await mux.respawnPane(paneId, { ...meta, metadata: meta })
      // 若旧命令恰在重启时结束，清掉它可能在 respawn 前刚写入的哨兵。
      if (existing.panePid !== undefined) await state.deleteExitFile(existing)
    } else {
      paneId = await mux.createManagedPane(meta)
    }
    const pane = (await mux.listPanes()).find((p) => p.paneId === paneId && p.taskId === meta.id)
    const timestamp = now()
    const task: ManagedTask = {
      id: meta.id, role, name: meta.name, cwd: meta.cwd, command, sessionId: meta.sessionId,
      source: identity.source ?? existing?.source, muxKind: backend.kind, socketName: backend.socketName,
      muxSession: pane?.sessionName ?? meta.muxSession, paneId, panePid: pane?.panePid,
      ...(pane ? paneResult(pane, await readExitCode(backend, pane, meta.id)) : { status: "gone" as const }),
      restartCount: existing ? existing.restartCount + 1 : 0, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    }
    await state.writeTask(task)
    return task
  }

  async function runBuild(options: RunBuildOptions): Promise<RunBuildResult> {
    const { wait = true, tailLines = 80 } = options
    const timeout = duration(options.timeoutMs ?? 120_000, "timeoutMs")
    duration(tailLines, "tailLines")
    const identity = { ...options, cwd: resolve(options.cwd) }
    const channel = wait ? `oc-build-${randomUUID()}` : undefined
    const initial = await locked(async () => start("build", identity, options.command, await findNamed("build", identity), channel))
    if (!wait) return { ok: initial.status !== "gone", task: initial, tail: "", timedOut: false }
    const mux = await client()
    const controller = new AbortController()
    const deadline = Date.now() + timeout
    let wake: (() => void) | undefined
    let notifiedAt: number | undefined
    void mux.waitForChannel(channel!, { timeoutMs: timeout, signal: controller.signal }).then((signaled) => {
      if (signaled) { notifiedAt = Date.now(); wake?.() }
    }, () => {})
    let task = initial
    try {
      while (task.status === "running" && sameRun(task, initial)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const interval = Math.min(remaining, polling)
        if (notifiedAt !== undefined) {
          // 没有哨兵时，收到通知后仍需等 tmux 更新 pane 的退出状态。
          await delay(Date.now() - notifiedAt < 250 ? Math.min(interval, 20) : interval)
        } else {
          await new Promise<void>((done) => {
            const timer = setTimeout(done, interval)
            wake = () => { clearTimeout(timer); done() }
          })
          wake = undefined
        }
        task = await observe(initial.id) ?? { ...task, status: "gone" }
      }
    } finally {
      controller.abort()
    }
    if (sameRun(task, initial) && task.status !== "running") {
      task = await locked(async () => {
        const { task: current, previous } = await readTaskSnapshot(initial.id)
        if (current && sameRun(current, initial)) await writeReconciled(current, previous)
        return current ?? { ...initial, status: "gone" }
      })
    }
    let tail = ""
    if (sameRun(task, initial) && task.status !== "gone" && !task.forceStopped) {
      const captured = await captureForRun(task, tailLines)
      if (captured.tail === undefined) task = captured.task ?? { ...task, status: "gone" }
      tail = captured.tail ?? ""
    }
    return {
      ok: sameRun(task, initial) && task.status === "succeeded", task, tail,
      timedOut: sameRun(task, initial) && task.status === "running",
    }
  }

  async function stop(lookup: () => Promise<ManagedTask | undefined>, options: StopTaskOptions): Promise<ServiceActionResult> {
    const begin = await locked(async (): Promise<{ requested: ManagedTask; timeout: number } | ServiceActionResult> => {
      const task = await lookup()
      if (!task) return { ok: false }
      if (task.status !== "running") return { ok: task.status !== "gone", task }
      const timeout = duration(options.timeoutMs ?? 2_000, "timeoutMs")
      const mux = await client()
      const requested = { ...task, stopRequested: true, updatedAt: now() }
      await state.writeTask(requested)
      try {
        await mux.sendInterrupt(task.paneId)
      } catch (error) {
        const current = await find(task.id)
        if (!current || !sameRun(current, requested)) return { ok: false, task: current }
        if (current.status !== "running") return { ok: current.status === "stopped", task: current }
        await state.writeTask({ ...current, stopRequested: task.stopRequested })
        throw error
      }
      return { requested, timeout }
    })
    if (!("requested" in begin)) return begin

    const { requested, timeout } = begin
    const deadline = performance.now() + timeout
    let observed = await observe(requested.id)
    while (observed?.status === "running" && sameRun(observed, requested)) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      await delay(Math.min(polling, remaining))
      observed = await observe(requested.id)
    }

    if (observed && !sameRun(observed, requested)) return { ok: false, task: observed }
    if (observed?.status === "running" && !options.force) return { ok: false, task: observed, timedOut: true }

    return locked(async () => {
      const { task: current, previous } = await readTaskSnapshot(requested.id)
      // 等待期间可重启或移除任务。即使 paneId 没变，也不能向新一轮运行发出 kill。
      if (!current || !sameRun(current, requested)) return { ok: false, task: current }
      if (current.status !== "running") {
        await writeReconciled(current, previous)
        return { ok: current.status === "stopped", task: current }
      }
      if (!options.force || performance.now() < deadline) return { ok: false, task: current, timedOut: performance.now() >= deadline }

      await (await client()).killPane(current.paneId)
      await state.deleteExitFile(current)
      const stopped: ManagedTask = { ...current, status: "stopped", forceStopped: true, panePid: undefined, updatedAt: now() }
      await state.writeTask(stopped)
      return { ok: true, task: stopped }
    })
  }

  async function deleteTaskState(task: ManagedTask): Promise<void> {
    await state.deleteExitFile(task)
    await state.deleteTask(task.id)
  }

  async function remove(task: ManagedTask): Promise<ServiceActionResult> {
    const mux = await client()
    if ((await mux.listPanes()).some((pane) => pane.paneId === task.paneId && pane.managed && pane.taskId === task.id)) {
      await mux.killPane(task.paneId)
    }
    await deleteTaskState(task)
    return { ok: true, task }
  }

  async function serviceAction(options: ServiceActionOptions): Promise<ServiceActionResult> {
    const identity = { ...options, cwd: resolve(options.cwd) }
    const { action } = options
    if (action === "stop") return stop(() => findNamed("service", identity), options)
    return locked(async () => {
      const task = await findNamed("service", identity)
      switch (action) {
        case "status": return { ok: !!task, task }
        case "remove": return task ? remove(task) : { ok: false }
        case "start":
          if (task?.status === "running" && !options.restartIfRunning) return { ok: true, task }
          // fall through
        case "restart": {
          const command = options.command ?? task?.command
          if (command === undefined) throw new MuxError("COMMAND_REQUIRED", "A command is required for a new service")
          const started = await start("service", identity, command, task)
          return { ok: started.status !== "gone", task: started }
        }
      }
    })
  }

  function restartTask(id: string, options: RestartTaskOptions = {}): Promise<ServiceActionResult> {
    return locked(async () => {
      const task = await find(id)
      if (!task) return { ok: false }
      const started = await start(task.role, { ...task, ...options }, options.command ?? task.command, task)
      return { ok: started.status !== "gone", task: started }
    })
  }

  function stopTask(id: string, options: StopTaskOptions = {}): Promise<ServiceActionResult> {
    return stop(() => find(id), options)
  }

  function removeTask(id: string): Promise<ServiceActionResult> {
    return locked(async () => {
      const task = await find(id)
      return task ? remove(task) : { ok: false }
    })
  }

  function closeSession({ cwd = process.cwd() }: { cwd?: string } = {}) {
    return locked(async () => {
      const sessionName = projectMuxSession(cwd)
      // 关闭前发现会话内未入库的受管 pane，同时保留已丢失 pane 的记录以便清理。
      const tasks = (await reconcile()).filter((task) => task.muxSession === sessionName)
      await (await client()).killSession(sessionName)
      await Promise.all(tasks.map(deleteTaskState))
      return { ok: true as const, removed: tasks.length, sessionName }
    })
  }

  async function liveTask(id: string): Promise<ManagedTask> {
    const task = await find(id)
    if (!task || task.status === "gone" || task.forceStopped) {
      throw noLivePane(id)
    }
    return task
  }

  return {
    getBackend,
    runBuild,
    serviceAction,
    restartTask,
    stopTask,
    removeTask,
    closeSession,
    captureLogs: async (id: string, lines?: number) => {
      const task = await observe(id)
      if (!task || task.status === "gone" || task.forceStopped) throw noLivePane(id)
      const { tail } = await captureForRun(task, lines)
      if (tail === undefined) throw noLivePane(id)
      return tail
    },
    sendInput: (id: string, input: string, { enter }: SendInputOptions = {}) => locked(async () => {
      const task = await liveTask(id)
      const mux = await client()
      if (!(await mux.listPanes()).some((pane) => pane.paneId === task.paneId && pane.taskId === id
        && pane.panePid === task.panePid && pane.managed && !pane.paneDead)) {
        throw noLivePane(id)
      }
      await mux.sendKeys(task.paneId, input, enter)
    }),
    listTasks: (filter: TaskFilter = {}) => locked(async () => (await reconcile()).filter((task) => matches(task, filter))),
    pruneGone: (filter: TaskFilter = {}) => locked(async () => {
      const gone = (await reconcile()).filter((task) => task.status === "gone" && matches(task, filter))
      await Promise.all(gone.map(deleteTaskState))
      return gone
    }),
    attachCommand: async (task: Pick<ManagedTask, "muxSession">) => buildAttachCommand(await getBackend(), task.muxSession),
  }
}

export type MuxManager = ReturnType<typeof createMuxManager>
