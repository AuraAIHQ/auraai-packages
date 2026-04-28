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
  // Bound work to maxLen + a small expansion budget for escapes.
  // Each char becomes at most "\\uNNNN" (6 chars), so cap input scan
  // at maxLen * 6 worst-case to avoid pathological loops.
  const inputCap = Math.min(value.length, maxLen * 6)
  const out: string[] = []
  let outLen = 0

  for (let i = 0; i < inputCap; i += 1) {
    if (outLen >= maxLen) {
      out.push('…')
      return out.join('')
    }
    const ch = value.charCodeAt(i)
    let chunk: string
    if ((ch >= 0x00 && ch <= 0x1f) || ch === 0x7f) {
      chunk = '\\x' + ch.toString(16).padStart(2, '0')
    } else if (ch === 0x2028 || ch === 0x2029) {
      // Unicode line separators — some pipelines treat as newlines.
      chunk = '\\u' + ch.toString(16).padStart(4, '0')
    } else {
      chunk = value[i]!
    }
    out.push(chunk)
    outLen += chunk.length
  }
  if (value.length > inputCap) {
    out.push('…')
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
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (maxConcurrent < 1) maxConcurrent = 1
  let active = 0
  const queue: QueueEntry[] = []

  // Wrap a release closure so double-call is a no-op (defensive).
  const makeReleaseClosure = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = queue.shift()
      if (next) {
        // Detach any abort handler from the entry we're servicing.
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
        // Hand a fresh one-shot release to the next waiter.
        next.resolve(makeReleaseClosure())
      } else {
        if (active > 0) active -= 1
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
        const entry: QueueEntry = { resolve, reject, signal }
        if (signal) {
          entry.onAbort = () => {
            // Remove this entry from the queue so the slot isn't
            // wasted on an abandoned waiter.
            const idx = queue.indexOf(entry)
            if (idx >= 0) queue.splice(idx, 1)
            reject(new SemaphoreAbortError(signal.reason))
          }
          signal.addEventListener('abort', entry.onAbort, { once: true })
        }
        queue.push(entry)
      })
    },
  }
}
