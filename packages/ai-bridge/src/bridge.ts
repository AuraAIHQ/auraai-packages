// AI bridge: implements the sdk's AIHandle on top of one or more
// adapters. Strategy:
//
// 1. Caller (or routing policy) picks a primary adapter for each call.
// 2. If the primary throws an AdapterError with a retryable code
//    (rate_limit, timeout, network), the bridge falls back through the
//    configured fallback chain.
// 3. Non-retryable errors (auth, invalid_request, context_overflow,
//    aborted, unsupported, unknown) are surfaced to the caller verbatim.
//
// M2 will add: streaming, model-capability matching, parallel "best of N",
// cost-aware routing.

import type { AIHandle } from '@auraaihq/sdk'
import type { Adapter, CompleteOptions, CompleteResult } from './adapter'
import { AdapterError } from './adapter'

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
  pickOrder(prompt: string, options: CompleteOptions | undefined, available: readonly string[]): readonly string[]
}

export interface BridgeOptions {
  /** Adapters available for routing. Order does not matter. */
  adapters: readonly Adapter[]
  /**
   * id of the default primary adapter. Must match an entry in `adapters`.
   * If omitted, the first adapter in `adapters` is used.
   */
  primary?: string
  /**
   * Ordered ids of fallback adapters; tried in sequence when primary
   * fails with a retryable error. Defaults to all non-primary adapters
   * in `adapters` order.
   */
  fallback?: readonly string[]
  /** Custom routing policy. Overrides primary/fallback if provided. */
  policy?: RoutingPolicy
}

export interface Bridge extends AIHandle {
  /** All registered adapter ids. */
  readonly adapterIds: readonly string[]
  /** Find an adapter by id. */
  getAdapter(id: string): Adapter | undefined
}

/**
 * Errors thrown by the bridge itself (not by adapters). Adapter errors
 * propagate as `AdapterError` after the fallback chain is exhausted.
 */
export class BridgeError extends Error {
  constructor(
    public readonly code:
      | 'no_adapters'
      | 'unknown_adapter'
      | 'all_adapters_failed'
      | 'unsupported_method',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

const RETRYABLE_CODES: ReadonlySet<AdapterError['code']> = new Set([
  'rate_limit',
  'timeout',
  'network',
])

export function createBridge(options: BridgeOptions): Bridge {
  if (options.adapters.length === 0) {
    throw new BridgeError('no_adapters', 'createBridge requires at least one adapter')
  }

  const adapterMap = new Map<string, Adapter>()
  for (const a of options.adapters) {
    if (adapterMap.has(a.metadata.id)) {
      throw new BridgeError(
        'unknown_adapter',
        `duplicate adapter id: ${a.metadata.id}`,
      )
    }
    adapterMap.set(a.metadata.id, a)
  }

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

  const defaultOrder = [primary, ...fallback]
  const policy = options.policy

  async function tryAdapters(
    prompt: string,
    completeOptions: CompleteOptions | undefined,
    order: readonly string[],
  ): Promise<CompleteResult> {
    const errors: AdapterError[] = []
    for (const id of order) {
      const adapter = adapterMap.get(id)
      if (!adapter) {
        // Unknown id from a policy is a programming bug — fail loud.
        throw new BridgeError(
          'unknown_adapter',
          `routing policy returned unknown adapter id: '${id}'`,
        )
      }
      try {
        const result = await adapter.complete(prompt, completeOptions)
        return { ...result, adapterId: id }
      } catch (error) {
        const adapterError = toAdapterError(error, id)
        errors.push(adapterError)
        // Non-retryable: don't fall through; surface immediately.
        if (!RETRYABLE_CODES.has(adapterError.code)) {
          throw adapterError
        }
      }
    }
    // All adapters failed with retryable errors — surface the chain.
    throw new BridgeError(
      'all_adapters_failed',
      `all ${order.length} adapter(s) failed: ` +
        errors.map((e) => `${e.adapterId}=${e.code}`).join(', '),
      errors,
    )
  }

  const bridge: Bridge = {
    adapterIds: [...adapterMap.keys()],

    getAdapter(id) {
      return adapterMap.get(id)
    },

    async complete(prompt, options) {
      const order = policy
        ? policy.pickOrder(prompt, options, [...adapterMap.keys()])
        : defaultOrder
      if (order.length === 0) {
        throw new BridgeError('no_adapters', 'routing policy returned empty order')
      }
      const result = await tryAdapters(prompt, options, order)
      return result.text
    },
  }

  return bridge
}

function toAdapterError(error: unknown, adapterId: string): AdapterError {
  if (error instanceof AdapterError) {
    return new AdapterError(error.code, error.message, adapterId, error.cause)
  }
  if (error instanceof Error) {
    return new AdapterError('unknown', error.message, adapterId, error)
  }
  return new AdapterError('unknown', String(error), adapterId, error)
}
