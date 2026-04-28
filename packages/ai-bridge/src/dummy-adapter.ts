// In-process adapter useful for tests and as a fallback. It can be
// configured to:
//   - return a fixed response,
//   - call a function for each prompt,
//   - throw a specific AdapterError code,
//   - simulate latency.
//
// Real adapters live in @auraaihq/ai-{idoris,claude,openai,local}.

import type { Adapter, AdapterMetadata, CompleteOptions, CompleteResult } from './adapter'
import { AdapterError } from './adapter'

export interface DummyAdapterOptions {
  id?: string
  /** Pre-canned text response. */
  text?: string
  /** Compute response from prompt + options. Overrides `text` if set. */
  respond?: (prompt: string, options: CompleteOptions | undefined) => string | Promise<string>
  /** Throw an AdapterError with this code on every call. */
  throwCode?: AdapterError['code']
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

export function createDummyAdapter(options: DummyAdapterOptions = {}): Adapter {
  const metadata: AdapterMetadata = {
    ...defaultMetadata,
    ...(options.metadata ?? {}),
    id: options.id ?? options.metadata?.id ?? defaultMetadata.id,
  }

  return {
    metadata,
    async complete(prompt, completeOptions): Promise<CompleteResult> {
      if (options.latencyMs && options.latencyMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, options.latencyMs)
          completeOptions?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              reject(new AdapterError('aborted', 'aborted by signal', metadata.id))
            },
            { once: true },
          )
        })
      }

      if (completeOptions?.signal?.aborted) {
        throw new AdapterError('aborted', 'aborted before completion', metadata.id)
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
