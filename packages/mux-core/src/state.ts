import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import type { ManagedTask } from "./types"

export function resolveMuxStateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.OPENCODE_MUX_STATE_DIR || (env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "opencode-mux") : join(home, ".local", "state", "opencode-mux"))
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

/** 文件名限制不允许路径分隔符、保留设备名或目录遍历。 */
export function isSafeTaskId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)
}

function checkTask(value: unknown, id: string): value is ManagedTask {
  if (!value || typeof value !== "object") return false
  const task = value as Partial<ManagedTask>
  return task.id === id
    && (task.role === "build" || task.role === "service")
    && (task.muxKind === "tmux" || task.muxKind === "psmux")
    && ["running", "succeeded", "failed", "stopped", "gone"].includes(task.status ?? "")
    && typeof task.name === "string" && typeof task.cwd === "string" && typeof task.command === "string"
    && typeof task.muxSession === "string" && /^%\d+$/.test(task.paneId ?? "")
    && Number.isSafeInteger(task.restartCount) && typeof task.createdAt === "string" && typeof task.updatedAt === "string"
}

export function createMuxState(stateDir = resolveMuxStateDir()) {
  const dir = join(stateDir, "tasks")
  const exitDir = resolve(stateDir, "exit")
  const pathFor = (id: string) => {
    if (!isSafeTaskId(id)) throw new Error(`Invalid mux task id: ${id}`)
    return join(dir, `${id}.json`)
  }

  function exitFilePrefix(paneId: string, id: string): string {
    if (!/^%\d+$/.test(paneId)) throw new Error(`Invalid mux pane id: ${paneId}`)
    if (!isSafeTaskId(id)) throw new Error(`Invalid mux task id: ${id}`)
    // pane 编号可被不同服务器复用；任务 ID 和 PID 区分不同任务及每次启动。
    return join(exitDir, `p${paneId.slice(1)}_${id}_`)
  }

  async function prepareExitFile(paneId: string, id: string): Promise<string> {
    const prefix = exitFilePrefix(paneId, id)
    await mkdir(exitDir, { recursive: true, mode: 0o700 })
    return prefix
  }

  async function findExitFiles(paneId: string, id: string): Promise<string[]> {
    const prefix = basename(exitFilePrefix(paneId, id))
    try {
      return (await readdir(exitDir)).filter((name) => name.startsWith(prefix) && /^\d+\.txt$/.test(name.slice(prefix.length)))
        .map((name) => join(exitDir, name))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async function readExitCode({ paneId, id, panePid }: Pick<ManagedTask, "paneId" | "id" | "panePid">): Promise<number | undefined> {
    // tmux 不为 dead pane 提供 PID；首次发现就已退出时，按任务查找唯一的哨兵。
    const files = panePid === undefined ? await findExitFiles(paneId, id) : [`${exitFilePrefix(paneId, id)}${panePid}.txt`]
    if (files.length !== 1) return undefined
    try {
      const content = await readFile(files[0], "utf8")
      const code = Number(content)
      return /^\d+\n$/.test(content) && Number.isSafeInteger(code) ? code : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async function deleteExitFile({ paneId, id, panePid }: Pick<ManagedTask, "paneId" | "id" | "panePid">): Promise<void> {
    const files = panePid === undefined ? await findExitFiles(paneId, id) : [`${exitFilePrefix(paneId, id)}${panePid}.txt`]
    await Promise.all(files.map((file) => rm(file, { force: true })))
  }

  async function readTask(id: string): Promise<ManagedTask | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(pathFor(id), "utf8"))
      return checkTask(value, id) ? value : undefined
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async function writeTask(task: ManagedTask): Promise<void> {
    const dest = pathFor(task.id)
    const temp = join(dir, `.${randomUUID()}.tmp`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await writeFile(temp, `${JSON.stringify(task, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      await rename(temp, dest)
    } finally {
      await rm(temp, { force: true })
    }
  }

  async function deleteTask(id: string): Promise<void> {
    await rm(pathFor(id), { force: true })
  }

  async function listTasks(): Promise<ManagedTask[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const ids = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5)).filter(isSafeTaskId).sort()
      return (await Promise.all(ids.map(readTask))).filter((task): task is ManagedTask => task !== undefined)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  return { stateDir, readTask, writeTask, deleteTask, listTasks, prepareExitFile, readExitCode, deleteExitFile }
}

export type MuxState = ReturnType<typeof createMuxState>
