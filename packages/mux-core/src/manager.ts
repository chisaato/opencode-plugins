import { createHash, randomUUID } from "node:crypto"
import { basename, resolve } from "node:path"
import { buildAttachCommand, createCommandRunner, detectMuxBackend, supportsPosixMuxFeatures } from "./backend"
import { resolveMuxConfig, validateTmuxBackendConfig } from "./config"
import { MuxError } from "./errors"
import { withStateLock } from "./lock"
import { createMuxState, isSafeTaskId } from "./state"
import { createMuxClient } from "./tmux"
import type {
  AdoptPaneOptions, LivePaneInfo, ManagedPaneOptions, ManagedTask, MuxBackend, MuxManagerOptions, PaneFilter,
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
  async function detectBackend(): Promise<MuxBackend> {
    const config = await resolveMuxConfig(options)
    if (options.backend) {
      const backend = { ...options.backend, ...config, platform: options.platform ?? options.backend.platform }
      await validateTmuxBackendConfig(backend)
      return backend
    }
    const backend = await detectMuxBackend({ ...options, ...config, runner })
    if (!backend) throw new MuxError("BACKEND_UNAVAILABLE", config.tmuxConfig === undefined
      ? "No tmux or psmux executable found"
      : "tmux executable required by the configured tmux.conf")
    return backend
  }
  function getBackend(): Promise<MuxBackend> {
    return backendPromise ??= detectBackend().catch((error) => {
      backendPromise = undefined
      throw error
    })
  }
  const client = async () => {
    const backend = await getBackend()
    return createMuxClient(backend, runner, {
      byobuKeys: options.byobuKeys ?? (backend.tmuxConfig === undefined),
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
        runningCommand: pane.foregroundCommand,
        ...paneResult(pane, exitCode, stopRequested),
        stopRequested,
        forceStopped: undefined,
        restartCount: storedTask.restartCount + Number(restarted),
      } : {
        ...storedTask,
        status: (storedTask.forceStopped ? "stopped" : "gone") as ManagedTask["status"],
        shell: undefined,
        runningCommand: undefined,
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
        runningCommand: pane.foregroundCommand,
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
      runningCommand: pane?.foregroundCommand,
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

  function historyFilter({ cwd, includeShell, retentionDays = 7 }: HistoryOptions) {
    const project = resolve(cwd)
    const retentionMs = duration(retentionDays, "retentionDays") * 86_400_000
    return {
      project,
      eligible: (task: ManagedTask) => task.cwd === project && task.status !== "running"
        && (!task.shell || includeShell === true)
        && (task.status === "gone" || Date.parse(task.updatedAt) <= Date.now() - retentionMs),
    }
  }

  async function historySnapshot(
    backend: MuxBackend, project: string, previous: ManagedTask | undefined, panes: LivePaneInfo[],
  ) {
    if (previous && previous.cwd !== project) return
    const [pane] = panes
    // 不清理被移动到别的会话、身份不明或在多个会话中链接的 pane。
    if (pane && (panes.length !== 1 || !pane.managed || !pane.role || pane.command === undefined || pane.cwd !== project
      || pane.sessionName !== projectMuxSession(project)
      || (previous && (pane.paneId !== previous.paneId || pane.sessionName !== previous.muxSession
        || pane.role !== previous.role || (pane.taskName ?? pane.windowName) !== previous.name
        || pane.command !== previous.command || pane.sessionId !== previous.sessionId)))) return
    const task = await taskSnapshot(backend, previous, panes)
    return task && { task, pane }
  }

  function previewHistory(options: HistoryOptions): Promise<ManagedTask[]> {
    return locked(async () => {
      const { project, eligible } = historyFilter(options)
      const backend = await getBackend()
      const [stored, panes] = await Promise.all([state.listTasks(), (await client()).listPanes()])
      const byId = new Map(stored.map((task) => [task.id, task]))
      const panesById = new Map<string, LivePaneInfo[]>()
      for (const pane of panes) {
        if (!pane.taskId || !isSafeTaskId(pane.taskId)) continue
        const group = panesById.get(pane.taskId) ?? []
        group.push(pane)
        panesById.set(pane.taskId, group)
      }
      const result: ManagedTask[] = []
      for (const id of new Set([...byId.keys(), ...panesById.keys()])) {
        const previous = byId.get(id)
        const current = await historySnapshot(backend, project, previous, panesById.get(id) ?? [])
        if (!current) continue
        await writeReconciled(current.task, previous)
        if (eligible(current.task)) result.push(current.task)
      }
      return result
    })
  }

  function cleanHistory({ candidates, ...options }: CleanHistoryOptions): Promise<CleanHistoryResult> {
    return locked(async () => {
      const { project, eligible } = historyFilter(options)
      const result: CleanHistoryResult = { removed: [], skipped: [], failed: [] }
      const seen = new Set<string>()
      for (const { id, updatedAt, restartCount } of candidates) {
        if (seen.has(id)) continue
        seen.add(id)
        try {
          const previous = isSafeTaskId(id) ? await state.readTask(id) : undefined
          if (!previous || !eligible(previous) || previous.updatedAt !== updatedAt || previous.restartCount !== restartCount) {
            result.skipped.push(id)
            continue
          }
          const backend = await getBackend()
          const mux = await client()
          const panes = (await mux.listPanes()).filter((pane) => pane.taskId === id)
          const current = await historySnapshot(backend, project, previous, panes)
          // 不接受新的终态、重新出现的 pane 或其他未在预览中确认的变化。
          if (!current || JSON.stringify(current.task) !== JSON.stringify(previous)) {
            result.skipped.push(id)
            continue
          }
          if (current.pane) await mux.killPane(current.pane.paneId)
          await deleteTaskState(previous)
          result.removed.push(id)
        } catch (error) {
          result.failed.push({ id, message: error instanceof Error ? error.message : String(error) })
        }
      }
      return result
    })
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
      if (options.mode === "input") {
        const mux = await client()
        if (task.status === "gone" || task.forceStopped || !(await mux.listPanes()).some((pane) =>
          pane.paneId === task.paneId && pane.taskId === id && pane.panePid === task.panePid
          && pane.managed && !pane.paneDead)) throw noLivePane(id)
        await mux.sendInterrupt(task.paneId)
        await mux.sendKeys(task.paneId, options.command ?? task.command, true)
        return { ok: true, task }
      }
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

  async function listPanes(filter: PaneFilter = {}): Promise<LivePaneInfo[]> {
    const cwd = filter.cwd === undefined ? undefined : resolve(filter.cwd)
    return (await (await client()).listPanes()).filter((pane) =>
      (filter.all === true || pane.sessionName.startsWith("oc-"))
      && (cwd === undefined || pane.cwd === cwd || pane.paneCurrentPath === cwd))
  }

  function adoptPane(options: AdoptPaneOptions): Promise<ManagedTask> {
    return locked(async () => {
      const backend = await getBackend()
      const mux = await client()
      const pane = (await mux.listPanes()).find((pane) => pane.paneId === options.paneId)
      if (!pane) throw noLivePane(options.paneId)
      if (pane.managed && pane.taskId) {
        const stored = await state.readTask(pane.taskId)
        if (stored) return stored
      }
      const meta: ManagedPaneOptions = {
        id: randomUUID(), role: options.role ?? "service",
        name: options.name ?? pane.taskName ?? pane.foregroundCommand ?? pane.paneCurrentCommand ?? "adopted",
        cwd: options.cwd ?? pane.cwd ?? pane.paneCurrentPath,
        command: options.command ?? pane.foregroundCommand ?? pane.paneCurrentCommand,
        muxSession: pane.sessionName, sessionId: pane.sessionId,
      }
      await mux.setPaneMetadata(pane.paneId, meta)
      const refreshed = (await mux.listPanes()).find((current) =>
        current.paneId === pane.paneId && current.managed && current.taskId === meta.id)
      if (!refreshed) throw noLivePane(options.paneId)
      const task = (await taskSnapshot(backend, undefined, [refreshed]))!
      await writeReconciled(task)
      return task
    })
  }

  return {
    getBackend,
    listPanes,
    adoptPane,
    runBuild,
    serviceAction,
    restartTask,
    stopTask,
    removeTask,
    closeSession,
    previewHistory,
    cleanHistory,
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

export interface HistoryOptions {
  cwd: string
  includeShell?: boolean
  retentionDays?: number
}

export type HistoryCandidate = Pick<ManagedTask, "id" | "updatedAt" | "restartCount">

export interface CleanHistoryOptions extends HistoryOptions {
  candidates: HistoryCandidate[]
}

export interface CleanHistoryResult {
  removed: string[]
  skipped: string[]
  failed: { id: string; message: string }[]
}

export type MuxManager = ReturnType<typeof createMuxManager>
