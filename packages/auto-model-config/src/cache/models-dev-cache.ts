import fs from "node:fs/promises"
import path from "node:path"
import type { ModelsDevData, AutoModelConfig } from "../types"
import { getDefaultCachePath, type PathResolutionOptions } from "../utils/paths"

const API_URL = "https://models.dev/api.json"
const DOWNLOAD_TIMEOUT_MS = 30000

export interface ModelsDevCacheOptions extends Pick<AutoModelConfig, "cacheTTL" | "cachePath">, PathResolutionOptions {}

export class ModelsDevCache {
  private cachePath: string
  private ttl: number

  constructor(options?: ModelsDevCacheOptions) {
    this.cachePath = options?.cachePath || getDefaultCachePath(options)
    this.ttl = (options?.cacheTTL ?? 86400) * 1000
  }

  /**
   * 获取 models.dev 数据。如果缓存有效则从缓存返回，否则下载。
   */
  async get(): Promise<ModelsDevData | null> {
    const cached = await this.readFromDisk()
    if (cached && this.isFresh(cached._fetchedAt)) {
      return cached.data
    }

    // 缓存未命中或已过期 — 尝试下载
    try {
      const data = await this.download()
      await this.writeToDisk(data)
      return data
    } catch (error) {
      // 如果下载失败但有过期缓存，则使用过期缓存
      if (cached) {
        console.warn(
          "[auto-model-config] Download failed, using stale cache",
          error instanceof Error ? error.message : String(error),
        )
        return cached.data
      }
      throw error
    }
  }

  /**
   * 强制从 models.dev 下载最新数据
   */
  async download(): Promise<ModelsDevData> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    try {
      const response = await fetch(API_URL, {
        method: "GET",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
      })

      if (!response.ok) {
        throw new Error(
          `Failed to download models.dev data: HTTP ${response.status}`,
        )
      }

      return (await response.json()) as ModelsDevData
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 检查缓存文件是否仍在 TTL 有效期内
   */
  isFresh(fetchedAt?: number): boolean {
    if (!fetchedAt) return false
    return Date.now() - fetchedAt < this.ttl
  }

  /**
   * 获取缓存年龄（秒）
   */
  async getAge(): Promise<number> {
    const cached = await this.readFromDisk()
    if (!cached?._fetchedAt) return -1
    return Math.floor((Date.now() - cached._fetchedAt) / 1000)
  }

  /**
   * 获取缓存文件路径（用于调试信息）
   */
  getCachePath(): string {
    return this.cachePath
  }

  private async readFromDisk(): Promise<{ _fetchedAt?: number; data: ModelsDevData } | null> {
    try {
      const raw = await fs.readFile(this.cachePath, "utf-8")
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private async writeToDisk(data: ModelsDevData): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
      const payload = {
        _fetchedAt: Date.now(),
        data,
      }
      await fs.writeFile(this.cachePath, JSON.stringify(payload, null, 2), "utf-8")
    } catch (err) {
      console.warn(`[auto-model-config] Failed to write cache to ${this.cachePath}:`, err)
    }
  }
}
