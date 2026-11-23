import type { HostClient } from "@openchamber/sdk"
import { describe, expect, it, vi } from "vitest"
import { createMuxClient, formatClientError, ServiceApiError } from "../src/ui/client"

function requestError(status: number, body: object) {
  const host: Pick<HostClient, "serviceRequest"> = {
    serviceRequest: vi.fn<HostClient["serviceRequest"]>().mockResolvedValue({ status, body: JSON.stringify(body) }),
  }
  return createMuxClient(host as HostClient).getLogs("missing-task")
}

describe("Mux 客户端错误协议", () => {
  it.each([
    [503, "BACKEND_UNAVAILABLE", "未检测到 tmux 或 psmux，请先安装后重试"],
    [400, "COMMAND_REQUIRED", "首次启动服务需要填写启动命令"],
    [404, "TASK_NO_LIVE_PANE", "未找到该任务，可能已被移除或终端窗格已失效"],
  ])("按错误码 %s/%s 本地化，不依赖英文消息", async (status, code, detail) => {
    const request = requestError(status, { code, error: "A different diagnostic" })
    await expect(request).rejects.toBeInstanceOf(ServiceApiError)
    await expect(request).rejects.toMatchObject({ status, code, message: "A different diagnostic" })
    await expect(request.catch(formatClientError)).resolves.toMatchObject({ code: status, detail })
  })

  it.each([
    [{ error: "Task not found" }, "未找到该任务，可能已被移除或终端窗格已失效"],
    [{ error: "An unknown diagnostic" }, "An unknown diagnostic"],
    [{ code: "FUTURE_CODE", error: "Task not found" }, "Task not found"],
  ])("兼容旧服务消息，并对未知错误码保留原文：%j", async (body, detail) => {
    await expect(requestError(404, body).catch(formatClientError)).resolves.toMatchObject({ detail })
  })
})
