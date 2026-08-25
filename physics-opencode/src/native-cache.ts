import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { runtimeDb } from "./paths.js"

type ThrottleRow = {
  last_request_ms: number
}

type CacheRow = {
  output: string
  cached_at_ms: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== "object") return value

  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  )
}

export function cacheKey(value: unknown): string {
  const canonical = JSON.stringify(stableValue(value))
  return createHash("sha256").update(canonical).digest("hex")
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted")
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  if (signal?.aborted) throw abortError(signal)

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal ? abortError(signal) : new Error("Operation aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export class NativeRuntimeStore {
  readonly path: string

  constructor(path = runtimeDb()) {
    this.path = path
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true })
    const database = new Database(this.path, { create: true })
    database.run("PRAGMA journal_mode = WAL")
    database.run("PRAGMA busy_timeout = 30000")
    database.run(
      "CREATE TABLE IF NOT EXISTS throttle(" +
        "key TEXT PRIMARY KEY, last_request_ms INTEGER NOT NULL)",
    )
    database.run(
      "CREATE TABLE IF NOT EXISTS text_cache(" +
        "namespace TEXT NOT NULL, cache_key TEXT NOT NULL, output TEXT NOT NULL, " +
        "cached_at_ms INTEGER NOT NULL, PRIMARY KEY(namespace, cache_key))",
    )
    return database
  }

  reserveRequest(key: string, minimumIntervalMs: number, nowMs = Date.now()): number {
    const database = this.open()
    try {
      database.run("BEGIN IMMEDIATE")
      const row = database
        .query<ThrottleRow, [string]>("SELECT last_request_ms FROM throttle WHERE key = ?")
        .get(key)
      const slot = Math.max(nowMs, (row?.last_request_ms ?? 0) + minimumIntervalMs)
      database
        .query(
          "INSERT INTO throttle(key, last_request_ms) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET last_request_ms = excluded.last_request_ms",
        )
        .run(key, slot)
      database.run("COMMIT")
      return Math.max(0, slot - nowMs)
    } catch (error) {
      if (database.inTransaction) database.run("ROLLBACK")
      throw error
    } finally {
      database.close()
    }
  }

  async waitForRequest(
    key: string,
    minimumIntervalMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await abortableDelay(this.reserveRequest(key, minimumIntervalMs), signal)
  }

  getCachedText(
    namespace: string,
    key: string,
    ttlMs: number,
    nowMs = Date.now(),
  ): string | undefined {
    const database = this.open()
    try {
      const row = database
        .query<CacheRow, [string, string]>(
          "SELECT output, cached_at_ms FROM text_cache WHERE namespace = ? AND cache_key = ?",
        )
        .get(namespace, key)
      if (!row) return undefined
      if (nowMs - row.cached_at_ms <= ttlMs) return row.output

      database
        .query("DELETE FROM text_cache WHERE namespace = ? AND cache_key = ?")
        .run(namespace, key)
      return undefined
    } finally {
      database.close()
    }
  }

  setCachedText(namespace: string, key: string, output: string, nowMs = Date.now()): void {
    const database = this.open()
    try {
      database
        .query(
          "INSERT INTO text_cache(namespace, cache_key, output, cached_at_ms) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(namespace, cache_key) DO UPDATE SET " +
            "output = excluded.output, cached_at_ms = excluded.cached_at_ms",
        )
        .run(namespace, key, output, nowMs)
    } finally {
      database.close()
    }
  }
}
