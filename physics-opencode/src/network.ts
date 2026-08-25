import { abortableDelay, NativeRuntimeStore } from "./native-cache.js"

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

export type FetchPolicy = {
  attempts?: number
  fetcher?: typeof fetch
  minimumIntervalMs?: number
  retryStatuses?: ReadonlySet<number>
  signal?: AbortSignal
  store?: NativeRuntimeStore
  throttleKey?: string
  timeoutMs?: number
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request aborted")
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  cleanup: () => void
  signal: AbortSignal
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => controller.abort(parent ? abortReason(parent) : new Error("Request aborted"))
  parent?.addEventListener("abort", onAbort, { once: true })
  if (parent?.aborted) onAbort()

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
    const timestamp = Date.parse(retryAfter)
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now())
  }
  return Math.min(2 ** attempt * 1_000, 30_000)
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  policy: FetchPolicy = {},
): Promise<Response> {
  const attempts = Math.max(1, policy.attempts ?? 3)
  const fetcher = policy.fetcher ?? fetch
  const retryStatuses = policy.retryStatuses ?? DEFAULT_RETRY_STATUSES
  const timeoutMs = policy.timeoutMs ?? 30_000
  let lastError: Error | undefined

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (policy.signal?.aborted) throw abortReason(policy.signal)
    if (policy.store && policy.throttleKey && policy.minimumIntervalMs !== undefined) {
      await policy.store.waitForRequest(policy.throttleKey, policy.minimumIntervalMs, policy.signal)
    }

    const scoped = requestSignal(policy.signal, timeoutMs)
    try {
      const response = await fetcher(input, { ...init, signal: scoped.signal })
      if (!retryStatuses.has(response.status) || attempt === attempts - 1) return response
      const delay = retryDelayMs(response, attempt)
      if (response.body) await response.body.cancel()
      await abortableDelay(delay, policy.signal)
    } catch (error) {
      if (policy.signal?.aborted) throw abortReason(policy.signal)
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === attempts - 1) throw lastError
      await abortableDelay(Math.min(2 ** attempt * 1_000, 30_000), policy.signal)
    } finally {
      scoped.cleanup()
    }
  }

  throw lastError ?? new Error("Request failed")
}

export async function responseText(response: Response, maxBytes = 2_000_000): Promise<string> {
  return new TextDecoder().decode(await responseBytes(response, maxBytes))
}

export async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response is too large (${declared} bytes; limit ${maxBytes})`)
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel(`Response exceeded the ${maxBytes}-byte limit`)
        throw new Error(`Response exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
