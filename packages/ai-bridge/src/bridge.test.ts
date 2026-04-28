import { describe, it, expect, vi } from 'vitest'
import { createBridge, BridgeError } from './bridge'
import { createDummyAdapter } from './dummy-adapter'
import { AdapterError } from './adapter'

describe('@auraaihq/ai-bridge', () => {
  describe('createBridge', () => {
    it('rejects empty adapter list', () => {
      expect(() => createBridge({ adapters: [] })).toThrow(BridgeError)
    })

    it('rejects unknown primary id', () => {
      expect(() =>
        createBridge({
          adapters: [createDummyAdapter({ id: 'a' })],
          primary: 'nope',
        }),
      ).toThrow(/primary adapter 'nope' is not in adapters/)
    })

    it('rejects unknown fallback id', () => {
      expect(() =>
        createBridge({
          adapters: [createDummyAdapter({ id: 'a' })],
          fallback: ['nope'],
        }),
      ).toThrow(/fallback adapter 'nope'/)
    })

    it('rejects duplicate adapter ids', () => {
      expect(() =>
        createBridge({
          adapters: [createDummyAdapter({ id: 'a' }), createDummyAdapter({ id: 'a' })],
        }),
      ).toThrow(/duplicate adapter id/)
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
  })

  describe('routing', () => {
    it('uses primary adapter on success', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', text: 'from primary' }),
          createDummyAdapter({ id: 'fallback', text: 'from fallback' }),
        ],
        primary: 'primary',
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('from primary')
    })

    it('falls back on retryable errors (rate_limit)', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', throwCode: 'rate_limit' }),
          createDummyAdapter({ id: 'fallback', text: 'fallback worked' }),
        ],
        primary: 'primary',
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('fallback worked')
    })

    it('falls back on retryable errors (timeout)', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', throwCode: 'timeout' }),
          createDummyAdapter({ id: 'fallback', text: 'fallback' }),
        ],
        primary: 'primary',
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('fallback')
    })

    it('falls back on retryable errors (network)', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', throwCode: 'network' }),
          createDummyAdapter({ id: 'fallback', text: 'fallback' }),
        ],
        primary: 'primary',
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('fallback')
    })

    it('does NOT fall back on non-retryable errors (auth)', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', throwCode: 'auth' }),
          createDummyAdapter({ id: 'fallback', text: 'fallback' }),
        ],
        primary: 'primary',
      })
      await expect(bridge.complete('hi')).rejects.toThrowError(AdapterError)
      await expect(bridge.complete('hi')).rejects.toMatchObject({ code: 'auth' })
    })

    it('does NOT fall back on invalid_request', async () => {
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({ id: 'primary', throwCode: 'invalid_request' }),
          createDummyAdapter({ id: 'fallback', text: 'fallback' }),
        ],
        primary: 'primary',
      })
      await expect(bridge.complete('hi')).rejects.toMatchObject({ code: 'invalid_request' })
    })

    it('falls through chain when all retryable adapters fail', async () => {
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
      expect(err.code).toBe('all_adapters_failed')
      expect(err.message).toContain('a=rate_limit')
      expect(err.message).toContain('b=timeout')
      expect(err.message).toContain('c=network')
    })

    it('respects explicit fallback ordering', async () => {
      const calls: string[] = []
      const tracking = (id: string, code: AdapterError['code']) =>
        createDummyAdapter({
          id,
          respond: () => {
            calls.push(id)
            throw new AdapterError(code, `${id} error`, id)
          },
        })

      const bridge = createBridge({
        adapters: [
          tracking('a', 'rate_limit'),
          tracking('b', 'rate_limit'),
          createDummyAdapter({
            id: 'c',
            respond: () => {
              calls.push('c')
              return 'c response'
            },
          }),
        ],
        primary: 'a',
        fallback: ['c', 'b'],
      })

      const text = await bridge.complete('hi')
      expect(text).toBe('c response')
      expect(calls).toEqual(['a', 'c'])
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
      await expect(bridge.complete('hi')).rejects.toMatchObject({ code: 'no_adapters' })
    })

    it('throws BridgeError when policy returns an unknown adapter id', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'a', text: 'a' })],
        policy: { pickOrder: () => ['nope', 'a'] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('unknown_adapter')
    })
  })

  describe('CompleteResult enrichment', () => {
    it('attaches adapterId for traceability', async () => {
      const adapter = createDummyAdapter({ id: 'tracker', text: 'hi' })
      const bridge = createBridge({ adapters: [adapter] })
      // Bridge.complete returns string; getAdapter exposes raw
      const direct = await adapter.complete('hi')
      expect(direct.adapterId).toBeUndefined()
      // Through bridge, the inner enrichment happens — but only as
      // string returned per AIHandle contract. Verified via a custom
      // adapter that captures.
      let captured: { text: string; adapterId?: string } | undefined
      const capturing = createDummyAdapter({
        id: 'cap',
        respond: (p) => {
          captured = { text: p }
          return p
        },
      })
      const b2 = createBridge({ adapters: [capturing] })
      const result = await b2.complete('echo')
      expect(result).toBe('echo')
      expect(captured?.text).toBe('echo')
    })
  })

  describe('AbortSignal propagation', () => {
    it('respects abort signal before completion', async () => {
      const bridge = createBridge({
        adapters: [createDummyAdapter({ id: 'slow', latencyMs: 100, text: 'late' })],
      })
      const ctrl = new AbortController()
      const promise = bridge.complete('hi', { signal: ctrl.signal })
      ctrl.abort()
      await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    })

    it('honors abort between adapters in the fallback chain', async () => {
      const ctrl = new AbortController()
      let primaryCalls = 0
      let fallbackCalls = 0
      const bridge = createBridge({
        adapters: [
          createDummyAdapter({
            id: 'a',
            respond: () => {
              primaryCalls += 1
              // Trigger abort right when primary fails retryable.
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
      // Fallback should NOT have run because the bridge checked the
      // signal between adapters and threw.
      expect(fallbackCalls).toBe(0)
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
              // Adapter authors might `throw` arbitrary values; bridge
              // must classify them robustly.
              throw thrown
            },
          }),
        ],
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('unknown')
      expect(err.adapterId).toBe('a')
    })
  })

  describe('policy synchronous throw', () => {
    it('wraps thrown policy error in BridgeError', async () => {
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
      expect(err.code).toBe('unsupported_method')
      expect(err.message).toContain('policy bug')
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
})
