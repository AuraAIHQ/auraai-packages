// In-process adapter useful for tests and as a deterministic fallback.
// Runs entirely in the calling process (no I/O, no network). It can be
// configured to:
//   - return a fixed response,
//   - call a function for each prompt,
//   - throw a specific AdapterError code,
//   - simulate latency.
//
// Real provider adapters live in @auraaihq/ai-{idoris,claude,openai,local}.

import type { Adapter, AdapterMetadata, CompleteOptions, CompleteResult } from './adapter'
import type { AdapterErrorCode } from './adapter'
import { AdapterError } from './adapter'

export interface InProcessAdapterOptions {
  id?: string
  /** Pre-canned text response. */
  text?: string
  /** Compute response from prompt + options. Overrides `text` if set. */
  respond?: (prompt: string, options: CompleteOptions | undefined) => string | Promise<string>
  /** Throw an AdapterError with this code on every call. */
  throwCode?: AdapterErrorCode
  /** Synthetic latency in ms before responding. */
  latencyMs?: number
  /** Override metadata fields. */
  metadata?: Partial<AdapterMetadata>
}

const defaultMetadata: AdapterMetadata = {
  id: 'in-process',
  name: 'In-Process Adapter',
  provider: 'other',
  local: true,
}

function abortedFromSignal(
  signal: AbortSignal | undefined,
  message: string,
  adapterId: string,
): AdapterError {
  return new AdapterError('aborted', message, adapterId, signal?.reason)
}

/**
 * Sleep for `ms`, rejecting early on abort. Always cleans up the
 * timer + abort listener — no leaks even on the success path.
 *
 * Race-safety: attaches the abort listener BEFORE the post-attach
 * `aborted` re-check, so an abort fired between the constructor's
 * synchronous body and the listener wiring is still caught (the
 * re-check sees it). Pre-checks `signal.aborted` to skip real
 * wall-clock time when the caller is already aborted.
 */
function abortableDelay(ms: number, signal: AbortSignal | undefined, adapterId: string): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortedFromSignal(signal, 'aborted before delay started', adapterId))
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const cleanup = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortedFromSignal(signal, 'aborted by signal', adapterId))
    }

    // Attach listener FIRST so any abort during construction is caught.
    signal?.addEventListener('abort', onAbort, { once: true })

    // Re-check synchronously: if abort fired between the pre-check
    // (above) and now, fire the listener manually and bail. Some
    // AbortSignal impls dispatch synchronously via .abort(), but
    // listeners added after .abort() do NOT auto-fire — we have to
    // detect it ourselves here.
    if (signal?.aborted) {
      onAbort()
      return
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}

export function createInProcessAdapter(options: InProcessAdapterOptions = {}): Adapter {
  const metadata: AdapterMetadata = {
    ...defaultMetadata,
    ...(options.metadata ?? {}),
    id: options.id ?? options.metadata?.id ?? defaultMetadata.id,
  }

  return {
    metadata,
    async complete(prompt, completeOptions): Promise<CompleteResult> {
      // Pre-check abort — don't even start latency timer if already aborted.
      if (completeOptions?.signal?.aborted) {
        throw abortedFromSignal(
          completeOptions.signal,
          'aborted before completion',
          metadata.id,
        )
      }

      if (options.latencyMs && options.latencyMs > 0) {
        await abortableDelay(options.latencyMs, completeOptions?.signal, metadata.id)
      }

      // Re-check after delay — could have been aborted during.
      if (completeOptions?.signal?.aborted) {
        throw abortedFromSignal(
          completeOptions.signal,
          'aborted after delay',
          metadata.id,
        )
      }

      if (options.throwCode) {
        throw new AdapterError(
          options.throwCode,
          `dummy throwing ${options.throwCode}`,
          metadata.id,
        )
      }

      const text = options.respond
        ? await options.respond(prompt, completeOptions)
        : (options.text ?? `[${metadata.id}] ${prompt}`)

      return {
        text,
        usage: {
          promptTokens: Math.ceil(prompt.length / 4),
          completionTokens: Math.ceil(text.length / 4),
        },
      }
    },
  }
}
