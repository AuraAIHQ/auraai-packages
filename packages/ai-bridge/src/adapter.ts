// Adapter contract that each concrete AI provider package implements.
//
// Concrete impls (`@auraaihq/ai-claude`, `@auraaihq/ai-local`, etc.)
// re-export an `adapter: Adapter` object that the bridge can register.
// M1 only ships the `complete` method; chat/streaming/tools arrive in M2.

export interface AdapterMetadata {
  /** Stable identifier (e.g. "claude", "ai-local-llava"). */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /** Provider family — used by routing policies. */
  readonly provider: 'idoris' | 'claude' | 'openai' | 'local' | 'other'
  /** Whether this adapter runs entirely on-device (no network). */
  readonly local: boolean
}

export interface CompleteOptions {
  /** Soft cap on output tokens. Adapters may clamp lower based on their model. */
  maxTokens?: number
  /** 0 = deterministic, 1 = creative. Adapter may clamp/round. */
  temperature?: number
  /** Optional system prompt prepended to the request. */
  system?: string
  /**
   * Abort signal. Adapters that can cancel mid-flight (HTTP, llama.cpp
   * generation) should respect this; others may finish current chunk
   * and reject after.
   */
  signal?: AbortSignal
}

export interface CompleteResult {
  /** The generated assistant text. */
  text: string
  /** Adapter id that produced the result (set by bridge for traceability). */
  adapterId?: string
  /** Approximate token usage when known. */
  usage?: { promptTokens: number; completionTokens: number }
}

/**
 * Error thrown by adapters. Includes a stable `code` so the bridge can
 * decide whether to retry/fallback. Adapters MUST classify network +
 * rate limit errors with these codes; everything else falls back to
 * `'unknown'` and is treated as fatal.
 */
export class AdapterError extends Error {
  constructor(
    public readonly code:
      | 'rate_limit'
      | 'timeout'
      | 'network'
      | 'auth'
      | 'invalid_request'
      | 'context_overflow'
      | 'unsupported'
      | 'aborted'
      | 'unknown',
    message: string,
    public readonly adapterId?: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

/**
 * The single capability surface every adapter exposes. M1 only requires
 * `complete`. Future versions will add `chat` (multi-turn) and `embed`.
 */
export interface Adapter {
  readonly metadata: AdapterMetadata
  /**
   * Generate a completion for the given prompt. Throws AdapterError
   * with a classified `code` on failure so the bridge can decide
   * whether to fall back to another adapter.
   */
  complete(prompt: string, options?: CompleteOptions): Promise<CompleteResult>
}
