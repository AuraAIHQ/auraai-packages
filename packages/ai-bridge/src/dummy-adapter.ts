// In-process adapter useful for tests and as a fallback. It can be
// configured to:
//   - return a fixed response,
//   - call a function for each prompt,
//   - throw a specific AdapterError code,
//   - simulate latency.
//
// Real adapters live in @auraaihq/ai-{idoris,claude,openai,local}.

import type { Adapter, AdapterMetadata, CompleteOptions, CompleteResult } from './adapter'
import type { AdapterErrorCode } from './adapter'
import { AdapterError } from './adapter'

export interface DummyAdapterOptions {
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
  id: 'dummy',
  name: 'Dummy Adapter',
  provider: 'other',
  local: true,
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
    return Promise.reject(new AdapterError('aborted', 'aborted before delay started', adapterId))
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
      reject(new AdapterError('aborted', 'aborted by signal', adapterId))
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

export function createDummyAdapter(options: DummyAdapterOptions = {}): Adapter {
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
        throw new AdapterError('aborted', 'aborted before completion', metadata.id)
      }

      if (options.latencyMs && options.latencyMs > 0) {
        await abortableDelay(options.latencyMs, completeOptions?.signal, metadata.id)
      }

      // Re-check after delay — could have been aborted during.
      if (completeOptions?.signal?.aborted) {
        throw new AdapterError('aborted', 'aborted after delay', metadata.id)
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
        : (options.text ?? `[dummy ${metadata.id}] ${prompt}`)

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
