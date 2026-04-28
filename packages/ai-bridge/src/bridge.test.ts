import { describe, it, expect, vi } from 'vitest'
import { createBridge, BridgeError } from './bridge'
import { createDummyAdapter } from './dummy-adapter'
import { AdapterError, isAdapterError, type AdapterErrorCode } from './adapter'

describe('@auraaihq/ai-bridge', () => {
  describe('createBridge', () => {
    it('rejects empty adapter list', () => {
      const err = (() => {
        try {
          createBridge({ adapters: [] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('no_adapters')
    })

    it('rejects unknown primary id (default policy only)', () => {
      const err = (() => {
        try {
          createBridge({
            adapters: [createDummyAdapter({ id: 'a' })],
            primary: 'nope',
          })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('unknown_adapter')
    })

    it('rejects unknown fallback id (default policy only)', () => {
      expect(() =>
        createBridge({
          adapters: [createDummyAdapter({ id: 'a' })],
          fallback: ['nope'],
        }),
      ).toThrow(/fallback adapter 'nope'/)
    })

    it('rejects duplicate adapter ids with duplicate_adapter code', () => {
      const err = (() => {
        try {
          createBridge({
            adapters: [createDummyAdapter({ id: 'a' }), createDummyAdapter({ id: 'a' })],
          })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('duplicate_adapter')
    })

    it('rejects default order with duplicates (primary appears in fallback)', () => {
      const err = (() => {
        try {
          createBridge({
            adapters: [createDummyAdapter({ id: 'a' }), createDummyAdapter({ id: 'b' })],
            primary: 'a',
            fallback: ['a'],
          })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('duplicate_in_order')
    })

    it('uses first adapter as primary when none specified', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'a', text: 'A response' }),
          createDummyAdapter({ id: 'b', text: 'B response' }),
        ],
      })
      const text = await bridge.complete('hello')
      expect(text).toBe('A response')
    })

    it('policy override does not validate primary/fallback', () => {
      // primary 'nope' would fail without policy; with policy it's ignored
      expect(() =>
        createBridge({
          adapters: [createDummyAdapter({ id: 'a' })],
          primary: 'nope',
          fallback: ['also-nope'],
          policy: { pickOrder: () => ['a'] },
        }),
      ).not.toThrow()
    })
  })

  describe('routing — recoverable codes (cross-adapter retry)', () => {
    it.each([
      'rate_limit',
      'timeout',
      'network',
      'context_overflow',
      'unsupported',
    ] as const satisfies readonly AdapterErrorCode[])(
      'falls through on %s',
      async (code) => {
        const bridge = createBridge({
          adapters: [
            createDummyAdapter({ id: 'primary', throwCode: code }),
            createDummyAdapter({ id: 'fallback', text: 'fallback' }),
          ],
          primary: 'primary',
        })
        const text = await bridge.complete('hi')
        expect(text).toBe('fallback')
      },
    )
  })

  describe('routing — fatal codes (immediate surface)', () => {
    it.each([
      'auth',
      'invalid_request',
    ] as const satisfies readonly AdapterErrorCode[])(
      'does NOT fall through on %s',
      async (code) => {
        const bridge = createBridge({
          adapters: [
            createDummyAdapter({ id: 'primary', throwCode: code }),
            createDummyAdapter({ id: 'fallback', text: 'fallback' }),
          ],
          primary: 'primary',
        })
        const err = await bridge.complete('hi').catch((e) => e)
        expect(isAdapterError(err)).toBe(true)
        expect((err as AdapterError).code).toBe(code)
      },
    )
  })

  describe('chain exhausted (aggregate BridgeError)', () => {
    it('throws BridgeError(aggregate) with cause holding chain', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'a', throwCode: 'rate_limit' }),
          createDummyAdapter({ id: 'b', throwCode: 'timeout' }),
          createDummyAdapter({ id: 'c', throwCode: 'network' }),
        ],
        primary: 'a',
        fallback: ['b', 'c'],
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('aggregate')
      expect(err.message).toContain('a=rate_limit')
      expect(err.message).toContain('b=timeout')
      expect(err.message).toContain('c=network')
      // Chain available via cause
      expect(Array.isArray(err.cause)).toBe(true)
      expect(err.cause).toHaveLength(3)
    })
  })

  describe('non-Error throws from adapter', () => {
    it.each([
      ['string', 'literal error'],
      ['null', null],
      ['undefined', undefined],
      ['object', { weird: 'shape' }],
      ['number', 42],
    ] as const)('classifies "%s" as unknown AdapterError', async (_label, thrown) => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({
            id: 'a',
            respond: () => {
              throw thrown
            },
          }),
        ],
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(isAdapterError(err)).toBe(true)
      expect((err as AdapterError).code).toBe('unknown')
      expect((err as AdapterError).adapterId).toBe('a')
    })
  })

  describe('original error preservation', () => {
    it('keeps original Error as cause', async () => {
      const original = new Error('underlying')
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({
            id: 'a',
            respond: () => {
              throw original
            },
          }),
        ],
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err.cause).toBe(original)
    })

    it('survives instanceof failure across module boundaries (structural guard)', async () => {
      // Simulate AdapterError from a different module copy by hand-rolling
      // an object with the right shape but NOT instanceof AdapterError.
      const fakeAdapterError = Object.assign(new Error('cross-realm rate limit'), {
        name: 'AdapterError',
        code: 'rate_limit' as AdapterErrorCode,
      })
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({
            id: 'a',
            respond: () => {
              throw fakeAdapterError
            },
          }),
          createDummyAdapter({ id: 'b', text: 'fallback worked' }),
        ],
        primary: 'a',
        fallback: ['b'],
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('fallback worked')
    })
  })

  describe('error field hygiene', () => {
    it('AdapterError cause is non-enumerable (not in JSON serialization)', () => {
      const err = new AdapterError('rate_limit', 'rl', 'a', { secret: 'token' })
      const json = JSON.stringify(err)
      expect(json).not.toContain('secret')
      expect(json).not.toContain('token')
      // But cause is still accessible via property
      expect(err.cause).toEqual({ secret: 'token' })
    })

    it('BridgeError cause is non-enumerable', () => {
      const err = new BridgeError('aggregate', 'all failed', { internal: 'sensitive' })
      const json = JSON.stringify(err)
      expect(json).not.toContain('sensitive')
      expect(err.cause).toEqual({ internal: 'sensitive' })
    })
  })

  describe('custom routing policy', () => {
    it('policy controls adapter order', async () => {
      const policy = {
        pickOrder: vi.fn((_prompt: string, _opts, _avail: readonly string[]) => ['b', 'a']),
      }
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'a', text: 'a' }),
          createDummyAdapter({ id: 'b', text: 'b' }),
        ],
        policy,
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('b')
      expect(policy.pickOrder).toHaveBeenCalled()
    })

    it('rejects empty order from policy', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a' })],
        policy: { pickOrder: () => [] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('no_adapters')
    })

    it('throws BridgeError(unknown_adapter) when policy returns id not in adapters', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a', text: 'a' })],
        policy: { pickOrder: () => ['nope', 'a'] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('unknown_adapter')
    })

    it('throws BridgeError(duplicate_in_order) when policy returns duplicates', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a' })],
        policy: { pickOrder: () => ['a', 'a'] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('duplicate_in_order')
    })

    it('wraps thrown policy error in BridgeError(policy_error)', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a', text: 'a' })],
        policy: {
          pickOrder: () => {
            throw new Error('policy bug')
          },
        },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('policy_error')
      expect(err.message).toContain('policy bug')
    })
  })

  describe('completeDetailed', () => {
    it('returns full CompleteResult with adapterId set by bridge', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'tracker', text: 'hi' })],
      })
      const result = await bridge.completeDetailed('prompt')
      expect(result.text).toBe('hi')
      expect(result.adapterId).toBe('tracker')
      expect(result.usage).toBeDefined()
    })

    it('overrides adapter-self-set adapterId with the actually-selected one', async () => {
      // Adapter sets a misleading adapterId; bridge corrects it.
      const sneaky = createDummyAdapter({
        id: 'real-id',
        respond: () => 'response',
      })
      // Wrap to inject adapterId=lying
      const wrapped = {
        ...sneaky,
        async complete(prompt: string, opts: Parameters<typeof sneaky.complete>[1]) {
          const r = await sneaky.complete(prompt, opts)
          return { ...r, adapterId: 'lying' }
        },
      }
      const bridge = createBridge({ adapters: [wrapped] })
      const result = await bridge.completeDetailed('hi')
      expect(result.adapterId).toBe('real-id') // bridge override wins
    })
  })

  describe('AbortSignal propagation', () => {
    it('respects abort signal already aborted at entry', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a', text: 'never reached' })],
      })
      const ctrl = new AbortController()
      ctrl.abort()
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(isAdapterError(err)).toBe(true)
      expect(err.code).toBe('aborted')
    })

    it('respects abort signal during latency', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'slow', latencyMs: 100, text: 'late' })],
      })
      const ctrl = new AbortController()
      const promise = bridge.complete('hi', { signal: ctrl.signal })
      ctrl.abort()
      await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    })

    it('honors abort between adapters in fallback chain (no wasted call)', async () => {
      const ctrl = new AbortController()
      let primaryCalls = 0
      let fallbackCalls = 0
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({
            id: 'a',
            respond: () => {
              primaryCalls += 1
              ctrl.abort()
              throw new AdapterError('rate_limit', 'rate limited', 'a')
            },
          }),
          createDummyAdapter({
            id: 'b',
            respond: () => {
              fallbackCalls += 1
              return 'b'
            },
          }),
        ],
        primary: 'a',
        fallback: ['b'],
      })
      await expect(bridge.complete('hi', { signal: ctrl.signal })).rejects.toMatchObject({
        code: 'aborted',
      })
      expect(primaryCalls).toBe(1)
      expect(fallbackCalls).toBe(0)
    })
  })

  describe('introspection', () => {
    it('exposes adapterIds', () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a' }), createDummyAdapter({ id: 'b' })],
      })
      expect([...bridge.adapterIds].sort()).toEqual(['a', 'b'])
    })

    it('getAdapter returns the adapter or undefined', () => {
      const a = createDummyAdapter({ id: 'a' })
      const bridge = createBridge({ adapters: [a] })
      expect(bridge.getAdapter('a')).toBe(a)
      expect(bridge.getAdapter('nope')).toBeUndefined()
    })
  })
})

describe('@auraaihq/ai-bridge isAdapterError', () => {
  it('matches actual AdapterError instances', () => {
    expect(isAdapterError(new AdapterError('rate_limit', 'msg'))).toBe(true)
  })

  it('matches structurally compatible objects (cross-realm safe)', () => {
    const fake = Object.assign(new Error('msg'), {
      name: 'AdapterError',
      code: 'timeout' as AdapterErrorCode,
    })
    expect(isAdapterError(fake)).toBe(true)
  })

  it('rejects plain Errors', () => {
    expect(isAdapterError(new Error('plain'))).toBe(false)
  })

  it('rejects objects with unknown code', () => {
    const fake = Object.assign(new Error('msg'), {
      name: 'AdapterError',
      code: 'made-up-code',
    })
    expect(isAdapterError(fake)).toBe(false)
  })

  it('rejects null/undefined/primitives', () => {
    expect(isAdapterError(null)).toBe(false)
    expect(isAdapterError(undefined)).toBe(false)
    expect(isAdapterError('string')).toBe(false)
    expect(isAdapterError(42)).toBe(false)
  })
})

describe('@auraaihq/ai-bridge dummy adapter', () => {
  it('returns text from `text` option', async () => {
    const a = createDummyAdapter({ text: 'hello' })
    const result = await a.complete('prompt')
    expect(result.text).toBe('hello')
  })

  it('returns text from `respond` callback', async () => {
    const a = createDummyAdapter({ respond: (p) => p.toUpperCase() })
    const result = await a.complete('hi there')
    expect(result.text).toBe('HI THERE')
  })

  it('uses default templated text when nothing provided', async () => {
    const a = createDummyAdapter({ id: 'd' })
    const result = await a.complete('q')
    expect(result.text).toBe('[dummy d] q')
  })

  it('throws AdapterError with the configured code', async () => {
    const a = createDummyAdapter({ throwCode: 'rate_limit' })
    const err = await a.complete('hi').catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.code).toBe('rate_limit')
  })

  it('reports usage tokens (rough estimate)', async () => {
    const a = createDummyAdapter({ text: 'response' })
    const result = await a.complete('input prompt')
    expect(result.usage?.promptTokens).toBe(Math.ceil('input prompt'.length / 4))
    expect(result.usage?.completionTokens).toBe(Math.ceil('response'.length / 4))
  })

  it('rejects immediately when signal already aborted (no latency wait)', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const a = createDummyAdapter({ latencyMs: 5000, text: 'unreachable' })
    const start = Date.now()
    const err = await a.complete('hi', { signal: ctrl.signal }).catch((e) => e)
    const elapsed = Date.now() - start
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.code).toBe('aborted')
    expect(elapsed).toBeLessThan(100) // didn't wait for the 5s latency
  })

  it('cleans up abort listener on success path (no leak)', async () => {
    const ctrl = new AbortController()
    const a = createDummyAdapter({ latencyMs: 10, text: 'ok' })
    const result = await a.complete('hi', { signal: ctrl.signal })
    expect(result.text).toBe('ok')
    // After success, aborting should have no observable effect (the
    // listener is gone). This test passes if we don't see unhandled
    // rejections or stale-listener errors.
    ctrl.abort()
  })
})
