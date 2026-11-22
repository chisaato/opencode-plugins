import { createMuxManager } from "@misakacloud/opencode-mux-core"
import { createServiceServer } from "./app"

const portValue = process.env.OPENCHAMBER_SERVICE_PORT ?? ""
const port = Number(portValue)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN
if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("OPENCHAMBER_SERVICE_PORT must be an integer from 1 to 65535")
}
if (!token?.trim()) throw new Error("OPENCHAMBER_SERVICE_TOKEN is required")

// 使用核心库的目录解析逻辑，与 OpenCode 插件共享任务状态。
const server = createServiceServer({ manager: createMuxManager(), token })
server.listen(port, "127.0.0.1")

let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  // 先让正在处理的请求完成，但不让挂起的子进程无限拖延退出。
  setTimeout(() => process.exit(0), 5_000).unref()
  server.close()
  server.closeIdleConnections()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
