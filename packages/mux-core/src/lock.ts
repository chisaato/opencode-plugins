import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { MuxError } from "./errors"

const lockWaitMs = 5_000
const sqliteBusy = 5

function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false
  // SQLite 扩展错误码的低字节是主错误码；SQLITE_LOCKED 不是 SQLITE_BUSY。
  return typeof error.errcode === "number" && (error.errcode & 0xff) === sqliteBusy
}

export async function withStateLock<T>(stateDir: string, work: () => Promise<T> | T): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, "manager-lock.sqlite")
  const deadline = performance.now() + lockWaitMs
  let db: DatabaseSync | undefined
  let lastBusy: unknown
  while (performance.now() < deadline) {
    try {
      db = new DatabaseSync(path)
      // 忙时立即返回，不让 SQLite 在 JS 线程上同步等待。
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
      break
    } catch (error) {
      db?.close()
      db = undefined
      if (!isBusy(error)) throw error
      lastBusy = error
      const remaining = deadline - performance.now()
      if (remaining > 0) await delay(Math.min(remaining, 10 + Math.random() * 30))
    }
  }
  if (!db) throw new MuxError("STATE_BUSY", `Mux state lock is busy: ${path}`, { cause: lastBusy })

  try {
    return await work()
  } finally {
    try {
      db.exec("ROLLBACK")
    } finally {
      db.close()
    }
  }
}
