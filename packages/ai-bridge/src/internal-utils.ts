// Internal helpers — not exported from the package's public surface.

/**
 * Sanitize a string for embedding in error messages so that log
 * pipelines / structured loggers can't be tricked into forging entries
 * via injected newlines / control characters (CWE-117).
 *
 * - Replaces ASCII control chars (0x00-0x1F, 0x7F) with their `\xNN`
 *   escape representation.
 * - Truncates to `maxLen` (default 200) with an ellipsis.
 *
 * Use sparingly — only on values that originate from untrusted sources
 * (adapter ids returned by user policy, thrown error messages, etc.).
 */
export function sanitizeForMessage(value: string, maxLen = 200): string {
  // Replace control chars (0x00-0x1F + 0x7F) with their hex escape.
  // Use char code rather than regex to avoid locale surprises.
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i)
    if ((ch >= 0x00 && ch <= 0x1f) || ch === 0x7f) {
      out += '\\x' + ch.toString(16).padStart(2, '0')
    } else {
      out += value[i]
    }
  }
  if (out.length > maxLen) {
    return out.slice(0, maxLen) + '…'
  }
  return out
}

/**
 * Tiny FIFO semaphore. `acquire()` resolves when a slot is available;
 * release the slot via the returned function. Designed for in-process
 * concurrency limiting on a single adapter — no fairness guarantees
 * across processes/workers.
 */
export interface Semaphore {
  acquire(): Promise<() => void>
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (maxConcurrent < 1) maxConcurrent = 1
  let active = 0
  const queue: Array<(release: () => void) => void> = []

  const release = (): void => {
    const next = queue.shift()
    if (next) {
      // Hand the same slot to the next waiter.
      next(release)
    } else {
      active -= 1
    }
  }

  return {
    acquire(): Promise<() => void> {
      if (active < maxConcurrent) {
        active += 1
        return Promise.resolve(release)
      }
      return new Promise<() => void>((resolve) => {
        queue.push(resolve)
      })
    },
  }
}
