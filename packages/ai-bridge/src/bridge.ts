// AI bridge: implements the sdk's AIHandle on top of one or more
// adapters. Strategy:
//
// 1. Caller (or routing policy) picks a primary adapter for each call.
// 2. If the primary throws an AdapterError with a cross-adapter
//    recoverable code (rate_limit, timeout, network, context_overflow,
//    unsupported), the bridge falls through to the next adapter in the
//    configured chain.
// 3. Cross-adapter fatal errors (auth, invalid_request, aborted,
//    unknown) are surfaced verbatim — switching adapters won't help.
//
// M2 will add: streaming, model-capability matching, parallel "best of N",
// cost-aware routing.

import type { AIHandle } from '@auraaihq/sdk'
import type {
  Adapter,
  AdapterErrorCode,
  CompleteOptions,
  CompleteResult,
} from './adapter'
import { AdapterError, isAdapterError } from './adapter'
import {
  sanitizeForMessage,
  safeToString,
  createSemaphore,
  normalizeMaxConcurrency,
  SemaphoreAbortError,
  type Semaphore,
} from './internal-utils'

interface SemaphoreEntry {
  sem: Semaphore
  /** The maxConcurrency value at first registration, for conflict detection. */
  max: number
}

/**
 * Module-level WeakMap keyed by Adapter instance so the concurrency
 * limit follows the adapter object — even when shared across multiple
 * bridges or pulled in via different packages. WeakMap doesn't pin
 * the adapter in memory; it's collected when the adapter is.
 *
 * Stores both the semaphore AND the max value so a second bridge
 * registering the same adapter with a different max can be detected
 * and rejected (we don't silently use stale config).
 */
const ADAPTER_SEMAPHORES = new WeakMap<Adapter, SemaphoreEntry>()

/**
 * Validate the structural shape of adapter metadata at runtime.
 * TypeScript signatures don't help when adapters are JS-authored or
 * when arbitrary objects are passed dynamically. Throws BridgeError
 * with `invalid_adapter_metadata` on shape failure.
 */
function validateMetadataShape(adapter: Adapter, indexHint: number): void {
  const m = adapter.metadata as unknown
  const where = `adapters[${indexHint}].metadata`
  if (!m || typeof m !== 'object') {
    throw new BridgeError(
      'invalid_adapter_metadata',
      `${where} must be an object, got ${typeof m}`,
    )
  }
  const meta = m as Record<string, unknown>
  if (typeof meta.id !== 'string' || meta.id.length === 0) {
    throw new BridgeError(
      'invalid_adapter_metadata',
      `${where}.id must be a non-empty string`,
    )
  }
  if (typeof meta.name !== 'string') {
    throw new BridgeError(
      'invalid_adapter_metadata',
      `adapter '${sanitizeForMessage(meta.id)}' metadata.name must be a string`,
    )
  }
  if (typeof meta.provider !== 'string') {
    throw new BridgeError(
      'invalid_adapter_metadata',
      `adapter '${sanitizeForMessage(meta.id)}' metadata.provider must be a string`,
    )
  }
  if (typeof meta.local !== 'boolean') {
    throw new BridgeError(
      'invalid_adapter_metadata',
      `adapter '${sanitizeForMessage(meta.id)}' metadata.local must be a boolean`,
    )
  }
}

/**
 * Routing policy — given a prompt + options, return ordered adapter
 * ids to try (first is primary, rest are fallbacks). The bridge looks
 * up actual adapters by id from its registry.
 *
 * The default policy returns `[primary, ...fallback]` from constructor
 * options regardless of prompt. Custom policies can implement task-type
 * detection, privacy gates ("never route to remote"), or cost limits.
 */
export interface RoutingPolicy {
  pickOrder(
    prompt: string,
    options: CompleteOptions | undefined,
    available: readonly string[],
  ): readonly string[]
}

export interface BridgeOptions {
  /** Adapters available for routing. Order does not matter. */
  adapters: readonly Adapter[]
  /**
   * id of the default primary adapter. Must match an entry in `adapters`.
   * If omitted, the first adapter in `adapters` is used.
   *
   * **Note**: when a custom `policy` is provided, `primary` and
   * `fallback` are NOT used and need not match anything in `adapters`.
   * They remain validated only when the default policy is in effect.
   */
  primary?: string
  /**
   * Ordered ids of fallback adapters; tried in sequence when primary
   * fails with a recoverable error. Defaults to all non-primary
   * adapters in `adapters` order.
   */
  fallback?: readonly string[]
  /** Custom routing policy. Overrides primary/fallback if provided. */
  policy?: RoutingPolicy
}

export interface Bridge extends AIHandle {
  /** All registered adapter ids. */
  readonly adapterIds: readonly string[]
  /**
   * Like `complete` but returns the full `CompleteResult` (text +
   * usage + the actual adapterId selected by routing). Use this for
   * telemetry / cost tracking; everyday callers should use
   * `complete()` per the AIHandle contract.
   */
  completeDetailed(prompt: string, options?: CompleteOptions): Promise<CompleteResult>
  /**
   * **Internal/debug only.** Returns the raw Adapter instance.
   * Bypasses routing — use with caution. Prefer `complete()` for
   * production code so retry/fallback semantics apply.
   */
  getAdapter(id: string): Adapter | undefined
}

/**
 * Stable error codes for bridge-level (not adapter-level) failures.
 *
 * - `no_adapters`: createBridge given no adapters, or policy returned []
 * - `unknown_adapter`: primary/fallback id not in adapters, or policy
 *   returned an id not in adapters
 * - `duplicate_adapter`: two adapters share the same id
 * - `duplicate_in_order`: routing order contains the same id twice
 * - `invalid_adapter_metadata`: adapter metadata failed validation
 *   (bad id type, invalid maxConcurrency, conflicting maxConcurrency
 *   across bridges sharing the same adapter instance)
 * - `policy_error`: RoutingPolicy.pickOrder threw
 * - `policy_invalid_return`: pickOrder didn't return an array of strings
 * - `aggregate`: every adapter in the order failed (with recoverable
 *   errors); see `cause` for the chain of underlying AdapterErrors
 * - `unsupported_method`: feature not implemented yet
 */
export type BridgeErrorCode =
  | 'no_adapters'
  | 'unknown_adapter'
  | 'duplicate_adapter'
  | 'duplicate_in_order'
  | 'policy_error'
  | 'policy_invalid_return'
  | 'invalid_adapter_metadata'
  | 'aggregate'
  | 'unsupported_method'

/**
 * Errors thrown by the bridge itself (not by adapters).
 *
 * - Adapter-level errors that surface immediately are thrown as
 *   `AdapterError` (with `code` like `'auth'` etc.).
 * - When every adapter in a routing chain fails recoverably, the
 *   bridge throws `BridgeError(code: 'aggregate')` with the chain
 *   of underlying `AdapterError`s in `cause`.
 *
 * `cause` is non-enumerable to avoid accidental serialization of
 * underlying request/response bodies that may contain secrets.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode

  constructor(
    code: BridgeErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * Codes for which the bridge will try the next adapter. Other codes
 * (auth, invalid_request, aborted, unknown) are treated as fatal:
 * switching adapters won't help, so we surface immediately.
 */
const CROSS_ADAPTER_RECOVERABLE: ReadonlySet<AdapterErrorCode> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'context_overflow',
  'unsupported',
])

/**
 * Reject a routing order that contains the same adapter id twice.
 * Calling the same adapter twice in one request is almost always
 * unintended (double-spend against rate limits / cost) and easy to
 * mis-author.
 */
function assertNoDuplicateIds(order: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id)) {
      throw new BridgeError(
        'duplicate_in_order',
        `routing order contains duplicate adapter id: '${sanitizeForMessage(id)}'`,
      )
    }
    seen.add(id)
  }
  return order
}

/**
 * Convert a signal abort into an AdapterError, preserving
 * AbortSignal.reason as the cause when the runtime exposes it. Useful
 * for distinguishing user cancel vs AbortSignal.timeout() etc.
 */
function abortedError(
  message: string,
  signal: AbortSignal | undefined,
  adapterId: string | undefined,
): AdapterError {
  const reason = signal?.reason
  return new AdapterError('aborted', message, adapterId, reason)
}

export function createBridge(options: BridgeOptions): Bridge {
  if (options.adapters.length === 0) {
    throw new BridgeError('no_adapters', 'createBridge requires at least one adapter')
  }

  // Build the registry first.
  const adapterMap = new Map<string, Adapter>()
  for (let i = 0; i < options.adapters.length; i += 1) {
    const a = options.adapters[i]!
    // Structural validation BEFORE using metadata fields.
    validateMetadataShape(a, i)

    if (adapterMap.has(a.metadata.id)) {
      throw new BridgeError(
        'duplicate_adapter',
        `duplicate adapter id: ${sanitizeForMessage(a.metadata.id)}`,
      )
    }
    adapterMap.set(a.metadata.id, a)

    // Per-adapter concurrency limiter. Stored in a module-level
    // WeakMap keyed by adapter INSTANCE so multiple bridges sharing
    // the same adapter object share the same limit (matches the
    // physical reality: one llama.cpp model session, one limit).
    const max = a.metadata.maxConcurrency
    if (max !== undefined) {
      let normalized: number
      try {
        normalized = normalizeMaxConcurrency(max)
      } catch (error) {
        const reason = error instanceof Error ? error.message : safeToString(error)
        throw new BridgeError(
          'invalid_adapter_metadata',
          `adapter '${sanitizeForMessage(a.metadata.id)}' has invalid maxConcurrency: ${sanitizeForMessage(reason)}`,
          error,
        )
      }
      // Conflict detection: if this adapter is already registered
      // with another bridge that picked a different maxConcurrency,
      // reject. Silently using stale config would be a footgun —
      // surfacing the drift lets the developer reconcile.
      const existing = ADAPTER_SEMAPHORES.get(a)
      if (existing) {
        if (existing.max !== normalized) {
          throw new BridgeError(
            'invalid_adapter_metadata',
            `adapter '${sanitizeForMessage(a.metadata.id)}' was previously registered with maxConcurrency=${existing.max}, refusing to re-register with ${normalized}`,
          )
        }
        // Same value — reuse existing semaphore.
      } else {
        ADAPTER_SEMAPHORES.set(a, { sem: createSemaphore(normalized), max: normalized })
      }
    }
  }

  const policy = options.policy

  // Compute / validate the default order ONLY when no custom policy.
  // With a custom policy, primary/fallback are unused and need not be
  // valid (they may be undefined or refer to dynamic ids).
  let defaultOrder: readonly string[]
  if (policy) {
    defaultOrder = []  // unused when policy is set
  } else {
    const primary = options.primary ?? options.adapters[0]!.metadata.id
    if (!adapterMap.has(primary)) {
      throw new BridgeError(
        'unknown_adapter',
        `primary adapter '${sanitizeForMessage(primary)}' is not in adapters list`,
      )
    }
    const fallback = options.fallback ?? options.adapters
      .map((a) => a.metadata.id)
      .filter((id) => id !== primary)
    for (const id of fallback) {
      if (!adapterMap.has(id)) {
        throw new BridgeError(
          'unknown_adapter',
          `fallback adapter '${sanitizeForMessage(id)}' is not in adapters list`,
        )
      }
    }
    defaultOrder = Object.freeze(assertNoDuplicateIds([primary, ...fallback]).slice())
  }

  /**
   * Run `adapter.complete(...)` under the adapter's concurrency
   * limiter (if declared); otherwise call directly. The limiter's
   * acquire is abortable so a queued request that gets cancelled
   * doesn't waste the slot on a subsequent adapter call.
   */
  async function callAdapter(
    adapter: Adapter,
    prompt: string,
    options: CompleteOptions | undefined,
  ): Promise<CompleteResult> {
    const entry = ADAPTER_SEMAPHORES.get(adapter)
    if (!entry) return adapter.complete(prompt, options)

    let release: () => void
    try {
      release = await entry.sem.acquire(options?.signal)
    } catch (error) {
      if (error instanceof SemaphoreAbortError) {
        throw new AdapterError(
          'aborted',
          'aborted while waiting for adapter slot',
          adapter.metadata.id,
          error.cause,
        )
      }
      throw error
    }

    try {
      // Re-check after acquire — the queue wait might have been long
      // and the caller may have aborted just before our slot opened.
      if (options?.signal?.aborted) {
        throw new AdapterError(
          'aborted',
          'aborted just before adapter call',
          adapter.metadata.id,
          options.signal.reason,
        )
      }
      return await adapter.complete(prompt, options)
    } finally {
      release()
    }
  }

  /**
   * Walk the adapter order calling each in turn. Returns on first
   * success. Throws on first fatal AdapterError. Throws aggregate
   * BridgeError if every adapter raised a recoverable error.
   */
  async function tryAdapters(
    prompt: string,
    completeOptions: CompleteOptions | undefined,
    order: readonly string[],
  ): Promise<CompleteResult> {
    const errors: AdapterError[] = []
    let lastAttemptedId: string | undefined
    for (const id of order) {
      // Honor abort between adapters. If user aborted after the
      // primary call returned, don't start the fallback. Attribute
      // the abort to the LAST adapter we actually tried (or omit
      // adapterId if we never started one) — not the next adapter
      // we never reached.
      if (completeOptions?.signal?.aborted) {
        throw abortedError(
          'request aborted between adapters',
          completeOptions.signal,
          lastAttemptedId,
        )
      }
      const adapter = adapterMap.get(id)
      if (!adapter) {
        // Unknown id from a policy is a programming bug — fail loud.
        throw new BridgeError(
          'unknown_adapter',
          `routing order contains unknown adapter id: '${sanitizeForMessage(id)}'`,
        )
      }
      lastAttemptedId = id
      try {
        const result = await callAdapter(adapter, prompt, completeOptions)
        // Adapters may not honor signal mid-flight (e.g., a local
        // sync llama.cpp call). Even if they returned a result, if
        // the signal was aborted during, treat as aborted — the
        // caller wanted to give up.
        if (completeOptions?.signal?.aborted) {
          throw abortedError(
            'request aborted during adapter completion',
            completeOptions.signal,
            id,
          )
        }
        return { ...result, adapterId: id }
      } catch (error) {
        const adapterError = toAdapterError(error, id)
        errors.push(adapterError)
        // Cross-adapter fatal: don't fall through; surface immediately.
        if (!CROSS_ADAPTER_RECOVERABLE.has(adapterError.code)) {
          throw adapterError
        }
      }
    }
    // Every adapter failed with a recoverable error — surface the
    // aggregate as BridgeError with the chain in `cause`.
    throw new BridgeError(
      'aggregate',
      `all ${order.length} adapter(s) failed: ` +
        errors
          .map((e) => `${sanitizeForMessage(e.adapterId ?? '?')}=${e.code}`)
          .join(', '),
      errors,
    )
  }

  // Define completeDetailed as a closure so the public API works
  // even when destructured (e.g. `const { complete } = bridge`).
  // Avoid `this`-coupling.
  async function completeDetailed(
    prompt: string,
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    // Early abort check — don't run policy if the caller already gave up.
    if (options?.signal?.aborted) {
      throw abortedError('request aborted before routing', options.signal, undefined)
    }

    let order: readonly string[]
    if (policy) {
      let policyOrder: readonly unknown[]
      // Hand the policy an immutable view of available ids so it
      // can't accidentally corrupt our internal state.
      const availableSnapshot = Object.freeze([...adapterMap.keys()])
      try {
        policyOrder = policy.pickOrder(prompt, options, availableSnapshot) as readonly unknown[]
      } catch (error) {
        const msg = error instanceof Error ? error.message : safeToString(error)
        throw new BridgeError(
          'policy_error',
          `routing policy threw: ${sanitizeForMessage(msg)}`,
          error,
        )
      }
      // Validate policy return shape — TypeScript's `readonly string[]`
      // signature can't enforce this at runtime; user policies (or
      // policies authored in plain JS) might return non-arrays or
      // non-string elements that would crash sanitization later.
      if (!Array.isArray(policyOrder)) {
        throw new BridgeError(
          'policy_invalid_return',
          `routing policy must return an array of strings, got ${typeof policyOrder}`,
        )
      }
      for (let i = 0; i < policyOrder.length; i += 1) {
        if (typeof policyOrder[i] !== 'string') {
          throw new BridgeError(
            'policy_invalid_return',
            `routing policy returned non-string at index ${i}: ${typeof policyOrder[i]}`,
          )
        }
      }
      const validatedOrder = policyOrder as readonly string[]
      if (validatedOrder.length === 0) {
        throw new BridgeError('no_adapters', 'routing policy returned empty order')
      }
      // Snapshot to defend against the policy mutating its own return
      // value mid-flight (would otherwise change the iteration target).
      const snapshot = Object.freeze([...validatedOrder])
      order = assertNoDuplicateIds(snapshot)
    } else {
      order = defaultOrder
    }

    return tryAdapters(prompt, options, order)
  }

  const bridge: Bridge = {
    // Frozen snapshot — callers can't mutate despite TypeScript's
    // readonly modifier (which is compile-time only).
    adapterIds: Object.freeze([...adapterMap.keys()]),

    getAdapter(id) {
      return adapterMap.get(id)
    },

    completeDetailed,

    async complete(prompt, opts) {
      const result = await completeDetailed(prompt, opts)
      return result.text
    },
  }

  return bridge
}

/**
 * Normalize whatever the adapter threw into an AdapterError, preserving
 * the original instance/stack as `cause`. Uses a structural guard so
 * errors from a different module copy still classify correctly.
 */
function toAdapterError(error: unknown, adapterId: string): AdapterError {
  if (isAdapterError(error)) {
    // Preserve original instance via cause; the original stack/identity
    // remains accessible for debugging. AdapterError messages from
    // genuine adapters are trusted (they're produced by adapter code,
    // not arbitrary remote payloads).
    if (error.adapterId === adapterId && error.cause !== undefined) {
      return error
    }
    return new AdapterError(error.code, error.message, adapterId, error)
  }
  if (error instanceof Error) {
    // Error.message can contain attacker-controlled content (e.g., a
    // remote API echoing back user input verbatim). Sanitize before
    // surfacing into a structured AdapterError that may end up logged.
    return new AdapterError('unknown', sanitizeForMessage(error.message), adapterId, error)
  }
  // Non-Error throws: safeToString never throws; sanitize the result.
  return new AdapterError('unknown', sanitizeForMessage(safeToString(error)), adapterId, error)
}
