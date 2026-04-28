// Internal helpers — not exported from the package's public surface.

/**
 * Best-effort string conversion that never throws. Adversarial
 * objects can have `toString()` that throws or returns non-string;
 * this helper catches all such cases.
 */
export function safeToString(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const stringified = String(value)
    if (typeof stringified === 'string') return stringified
    return Object.prototype.toString.call(value)
  } catch {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return '<unstringifiable>'
    }
  }
}

/**
 * Sanitize a string for embedding in error messages so that log
 * pipelines / structured loggers can't be tricked into forging entries
 * via injected newlines / control characters (CWE-117).
 *
 * - Replaces ASCII control chars (0x00-0x1F, 0x7F) and the Unicode
 *   line separators (U+2028, U+2029) with `\xNN` / `\uNNNN` escapes.
 * - Truncates to `maxLen` (default 200) with an ellipsis. Truncation
 *   happens during the scan to bound CPU/memory on adversarially
 *   long inputs.
 *
 * Use sparingly — only on values that originate from untrusted sources
 * (adapter ids returned by user policy, thrown error messages, etc.).
 */
export function sanitizeForMessage(value: string, maxLen = 200): string {
  if (typeof value !== 'string') {
    value = safeToString(value)
  }
  // Edge cases for tiny maxLen — guarantee output.length <= maxLen.
  if (maxLen <= 0) return ''
  const ellipsis = '…'
  if (maxLen <= ellipsis.length) {
    // Can't even fit the ellipsis cleanly — truncate the value
    // characters directly without escapes/ellipsis logic.
    return value.length > maxLen ? value.slice(0, maxLen) : value
  }
  const budget = maxLen - ellipsis.length
  // Bound input scan to maxLen * 6 worst-case (each char up to \\uNNNN = 6).
  const inputCap = Math.min(value.length, maxLen * 6)
  const out: string[] = []
  let outLen = 0

  for (let i = 0; i < inputCap; i += 1) {
    const ch = value.charCodeAt(i)
    let chunk: string
    if ((ch >= 0x00 && ch <= 0x1f) || ch === 0x7f) {
      chunk = '\\x' + ch.toString(16).padStart(2, '0')
    } else if (ch === 0x2028 || ch === 0x2029) {
      chunk = '\\u' + ch.toString(16).padStart(4, '0')
    } else {
      chunk = value[i]!
    }
    if (outLen + chunk.length > budget) {
      out.push(ellipsis)
      return out.join('')
    }
    out.push(chunk)
    outLen += chunk.length
  }
  if (value.length > inputCap) {
    while (out.length > 0 && outLen + ellipsis.length > maxLen) {
      const removed = out.pop()!
      outLen -= removed.length
    }
    out.push(ellipsis)
  }
  return out.join('')
}

/**
 * Tiny FIFO semaphore with **abortable acquire**. `acquire(signal?)`
 * resolves with a one-shot release function when a slot is free; when
 * `signal` is provided and the signal aborts before/while waiting,
 * acquire rejects (and any queued waiter is removed without leaking).
 *
 * Designed for in-process concurrency limiting on a single adapter —
 * no fairness guarantees across processes/workers.
 */
export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<() => void>
}

export class SemaphoreAbortError extends Error {
  constructor(cause?: unknown) {
    super(
      'semaphore acquire aborted',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'SemaphoreAbortError'
  }
}

/**
 * Validate a concurrency limit. Strict: must be a positive integer
 * (no NaN, Infinity, floats, strings, or other types). Returns the
 * value unchanged on success; throws TypeError otherwise.
 */
export function normalizeMaxConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Use safeToString — adversarial objects with throwing toString
    // would otherwise crash this helper.
    throw new TypeError(
      `maxConcurrency must be a finite number, got ${typeof value}: ${safeToString(value)}`,
    )
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `maxConcurrency must be an integer, got ${value}`,
    )
  }
  if (value < 1) {
    throw new TypeError(
      `maxConcurrency must be >= 1, got ${value}`,
    )
  }
  return value
}

interface QueueEntry {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
  /** Cancellation tombstone — release skips canceled entries. */
  canceled: boolean
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (maxConcurrent < 1) maxConcurrent = 1
  let active = 0
  // Head-index queue: O(1) dequeue and O(1) cancel via tombstone.
  // Periodically compacted when head exceeds half the queue length
  // to avoid unbounded memory growth.
  const queue: QueueEntry[] = []
  let head = 0

  const compactIfNeeded = (): void => {
    if (head > 16 && head * 2 > queue.length) {
      queue.splice(0, head)
      head = 0
    }
  }

  const makeReleaseClosure = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      // Advance past any canceled entries.
      while (head < queue.length && queue[head]!.canceled) {
        head += 1
      }
      const next = head < queue.length ? queue[head] : undefined
      if (next) {
        head += 1
        compactIfNeeded()
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
        next.resolve(makeReleaseClosure())
      } else {
        // Queue empty — return slot to pool.
        if (active > 0) active -= 1
        // No more entries means head === queue.length; clear array.
        if (queue.length > 0) {
          queue.length = 0
          head = 0
        }
      }
    }
  }

  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) {
        return Promise.reject(new SemaphoreAbortError(signal.reason))
      }
      if (active < maxConcurrent) {
        active += 1
        return Promise.resolve(makeReleaseClosure())
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry: QueueEntry = { resolve, reject, signal, canceled: false }
        if (signal) {
          entry.onAbort = () => {
            // Mark as canceled — release will skip it. O(1) instead
            // of indexOf+splice (which would be O(n) per cancel and
            // cause O(n²) under heavy contention).
            entry.canceled = true
            reject(new SemaphoreAbortError(signal.reason))
          }
          signal.addEventListener('abort', entry.onAbort, { once: true })
        }
        queue.push(entry)
      })
    },
  }
}
