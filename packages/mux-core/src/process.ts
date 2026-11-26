import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "csh", "tcsh", "nu", "elvish"])
const maxProcesses = 64
const maxDepth = 12

export function readForegroundCommand(panePid: number | undefined): string | undefined {
  try {
    if (!Number.isSafeInteger(panePid) || panePid! <= 0) return undefined
    let readProcess: (pid: number) => { executable: string; command: string; children: number[] }
    if (process.platform === "linux") {
      readProcess = (pid) => {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()
        return {
          executable: argv[0] ?? "",
          command: argv.join(" ").trim(),
          children: children ? children.split(/\s+/).map(Number) : [],
        }
      }
    } else if (process.platform === "darwin") {
      const processes = new Map<number, { executable: string; command: string; children: number[] }>()
      const children = new Map<number, number[]>()
      const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024,
      })
      for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        if (!match) continue
        const [, pid, parent, command] = match
        processes.set(Number(pid), { executable: command.split(/\s+/)[0], command: command.trim(), children: [] })
        const siblings = children.get(Number(parent)) ?? []
        siblings.push(Number(pid))
        children.set(Number(parent), siblings)
      }
      readProcess = (pid) => {
        const entry = processes.get(pid)
        if (!entry) throw new Error("Process disappeared")
        return { ...entry, children: children.get(pid) ?? [] }
      }
    } else {
      return undefined
    }

    const queue = [{ pid: panePid!, depth: 0 }]
    const seen = new Set<number>()
    for (let index = 0; index < queue.length && index < maxProcesses; index++) {
      const { pid, depth } = queue[index]
      if (seen.has(pid)) continue
      seen.add(pid)
      const entry = readProcess(pid)
      if (entry.command && !shells.has(basename(entry.executable).replace(/^-/, ""))) {
        return entry.command.slice(0, 400)
      }
      if (depth < maxDepth) {
        for (const child of entry.children) {
          if (queue.length >= maxProcesses) break
          queue.push({ pid: child, depth: depth + 1 })
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
