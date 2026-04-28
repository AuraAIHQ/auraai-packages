// Adapter contract that each concrete AI provider package implements.
//
// Concrete impls (`@auraaihq/ai-claude`, `@auraaihq/ai-local`, etc.)
// re-export an `adapter: Adapter` object that the bridge can register.
// M1 only ships the `complete` method; chat/streaming/tools arrive in M2.

/**
 * Common provider families. The `provider` field is intentionally an
 * open string — new providers (e.g., `'mistral'`, `'gemini'`, custom)
 * don't require a release of this package. Code that branches on
 * provider should default-handle unknown values.
 */
export type ProviderFamily =
  | 'idoris'
  | 'claude'
  | 'openai'
  | 'local'
  | 'other'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

export interface AdapterMetadata {
  /** Stable identifier (e.g. "claude", "ai-local-llava"). */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /** Provider family — open string, common values listed above. */
  readonly provider: ProviderFamily
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
 * Stable error codes thrown by adapters.
 *
 * Cross-adapter recoverable (bridge falls through to next adapter):
 * - `rate_limit`: this adapter is rate limited
 * - `timeout`: this adapter timed out
 * - `network`: network failure reaching this adapter
 * - `context_overflow`: prompt too large for this adapter's model
 * - `unsupported`: this adapter doesn't support the requested capability
 *
 * Cross-adapter fatal (bridge surfaces immediately):
 * - `auth`: credentials wrong; trying another adapter won't help
 * - `invalid_request`: caller's request is malformed
 * - `aborted`: caller signaled abort
 * - `unknown`: unclassified — bridge cannot reason about retry safety
 */
export type AdapterErrorCode =
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'context_overflow'
  | 'unsupported'
  | 'auth'
  | 'invalid_request'
  | 'aborted'
  | 'unknown'

/**
 * Error thrown by adapters. Includes a stable `code` so the bridge can
 * decide whether to fall through to another adapter.
 *
 * Note: `cause` is preserved via the standard `Error.cause` mechanism
 * (ES2022) and is non-enumerable by default — it does NOT leak through
 * `JSON.stringify(err)`. This avoids accidental exfil of provider
 * request bodies (which often contain prompts, tokens, headers).
 */
export class AdapterError extends Error {
  /** Stable error code for retry/fallback classification. */
  readonly code: AdapterErrorCode
  /** Optional id of the adapter that produced this error. */
  readonly adapterId?: string

  constructor(
    code: AdapterErrorCode,
    message: string,
    adapterId?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AdapterError'
    this.code = code
    this.adapterId = adapterId
  }
}

/**
 * Structural type guard for AdapterError that survives realm/duplicate-
 * package boundaries (workers, multiple installs of @auraaihq/ai-bridge,
 * bundling pitfalls). Prefer this over `instanceof AdapterError` in the
 * bridge — `instanceof` returns false when the AdapterError comes from
 * a different copy of this module.
 */
export function isAdapterError(value: unknown): value is AdapterError {
  if (!value || typeof value !== 'object') return false
  const v = value as { name?: unknown; code?: unknown; message?: unknown }
  return (
    v.name === 'AdapterError' &&
    typeof v.message === 'string' &&
    typeof v.code === 'string' &&
    isKnownErrorCode(v.code)
  )
}

const KNOWN_ERROR_CODES = new Set<string>([
  'rate_limit',
  'timeout',
  'network',
  'context_overflow',
  'unsupported',
  'auth',
  'invalid_request',
  'aborted',
  'unknown',
])

function isKnownErrorCode(code: string): code is AdapterErrorCode {
  return KNOWN_ERROR_CODES.has(code)
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
