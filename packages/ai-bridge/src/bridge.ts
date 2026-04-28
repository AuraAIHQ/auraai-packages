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
 * - `unknown_adapter`: primary/fallback id not in adapters
 * - `duplicate_adapter`: two adapters share the same id
 * - `duplicate_in_order`: routing order contains the same id twice
 * - `policy_error`: RoutingPolicy.pickOrder threw
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
        `routing order contains duplicate adapter id: '${id}'`,
      )
    }
    seen.add(id)
  }
  return order
}

export function createBridge(options: BridgeOptions): Bridge {
  if (options.adapters.length === 0) {
    throw new BridgeError('no_adapters', 'createBridge requires at least one adapter')
  }

  // Build the registry first.
  const adapterMap = new Map<string, Adapter>()
  for (const a of options.adapters) {
    if (adapterMap.has(a.metadata.id)) {
      throw new BridgeError(
        'duplicate_adapter',
        `duplicate adapter id: ${a.metadata.id}`,
      )
    }
    adapterMap.set(a.metadata.id, a)
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
        `primary adapter '${primary}' is not in adapters list`,
      )
    }
    const fallback = options.fallback ?? options.adapters
      .map((a) => a.metadata.id)
      .filter((id) => id !== primary)
    for (const id of fallback) {
      if (!adapterMap.has(id)) {
        throw new BridgeError(
          'unknown_adapter',
          `fallback adapter '${id}' is not in adapters list`,
        )
      }
    }
    defaultOrder = assertNoDuplicateIds([primary, ...fallback])
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
        throw new AdapterError(
          'aborted',
          'request aborted between adapters',
          lastAttemptedId,
        )
      }
      const adapter = adapterMap.get(id)
      if (!adapter) {
        // Unknown id from a policy is a programming bug — fail loud.
        throw new BridgeError(
          'unknown_adapter',
          `routing order contains unknown adapter id: '${id}'`,
        )
      }
      lastAttemptedId = id
      try {
        const result = await adapter.complete(prompt, completeOptions)
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
        errors.map((e) => `${e.adapterId}=${e.code}`).join(', '),
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
      throw new AdapterError('aborted', 'request aborted before routing')
    }

    let order: readonly string[]
    if (policy) {
      try {
        order = policy.pickOrder(prompt, options, [...adapterMap.keys()])
      } catch (error) {
        throw new BridgeError(
          'policy_error',
          `routing policy threw: ${error instanceof Error ? error.message : String(error)}`,
          error,
        )
      }
      if (order.length === 0) {
        throw new BridgeError('no_adapters', 'routing policy returned empty order')
      }
      // Policy-supplied orders may also contain duplicates; reject loudly.
      order = assertNoDuplicateIds(order)
    } else {
      order = defaultOrder
    }

    return tryAdapters(prompt, options, order)
  }

  const bridge: Bridge = {
    adapterIds: [...adapterMap.keys()],

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
    // remains accessible for debugging.
    if (error.adapterId === adapterId && error.cause !== undefined) {
      return error
    }
    return new AdapterError(error.code, error.message, adapterId, error)
  }
  if (error instanceof Error) {
    return new AdapterError('unknown', error.message, adapterId, error)
  }
  return new AdapterError('unknown', String(error), adapterId, error)
}
