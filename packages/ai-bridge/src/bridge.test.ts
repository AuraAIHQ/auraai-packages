import { describe, it, expect, vi } from 'vitest'
import { createBridge, BridgeError } from './bridge'
import { createInProcessAdapter } from './in-process-adapter'
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
            adapters: [createInProcessAdapter({ id: 'a' })],
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
          adapters: [createInProcessAdapter({ id: 'a' })],
          fallback: ['nope'],
        }),
      ).toThrow(/fallback adapter 'nope'/)
    })

    it('rejects duplicate adapter ids with duplicate_adapter code', () => {
      const err = (() => {
        try {
          createBridge({
            adapters: [createInProcessAdapter({ id: 'a' }), createInProcessAdapter({ id: 'a' })],
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
            adapters: [createInProcessAdapter({ id: 'a' }), createInProcessAdapter({ id: 'b' })],
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
          createInProcessAdapter({ id: 'a', text: 'A response' }),
          createInProcessAdapter({ id: 'b', text: 'B response' }),
        ],
      })
      const text = await bridge.complete('hello')
      expect(text).toBe('A response')
    })

    it('policy override does not validate primary/fallback', () => {
      // primary 'nope' would fail without policy; with policy it's ignored
      expect(() =>
        createBridge({
          adapters: [createInProcessAdapter({ id: 'a' })],
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
            createInProcessAdapter({ id: 'primary', throwCode: code }),
            createInProcessAdapter({ id: 'fallback', text: 'fallback' }),
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
            createInProcessAdapter({ id: 'primary', throwCode: code }),
            createInProcessAdapter({ id: 'fallback', text: 'fallback' }),
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
          createInProcessAdapter({ id: 'a', throwCode: 'rate_limit' }),
          createInProcessAdapter({ id: 'b', throwCode: 'timeout' }),
          createInProcessAdapter({ id: 'c', throwCode: 'network' }),
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
          createInProcessAdapter({
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
          createInProcessAdapter({
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
          createInProcessAdapter({
            id: 'a',
            respond: () => {
              throw fakeAdapterError
            },
          }),
          createInProcessAdapter({ id: 'b', text: 'fallback worked' }),
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
          createInProcessAdapter({ id: 'a', text: 'a' }),
          createInProcessAdapter({ id: 'b', text: 'b' }),
        ],
        policy,
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('b')
      expect(policy.pickOrder).toHaveBeenCalled()
    })

    it('rejects empty order from policy', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: { pickOrder: () => [] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('no_adapters')
    })

    it('throws BridgeError(unknown_adapter) when policy returns id not in adapters', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a', text: 'a' })],
        policy: { pickOrder: () => ['nope', 'a'] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('unknown_adapter')
    })

    it('throws BridgeError(policy_invalid_return) when policy returns non-array', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: { pickOrder: () => ('not-an-array' as unknown as readonly string[]) },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('policy_invalid_return')
    })

    it('rejects unbounded policy returns to prevent DoS (>1024 entries)', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: {
          pickOrder: () => Array(2000).fill('a') as readonly string[],
        },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('policy_invalid_return')
      expect((err as Error).message).toContain('2000 entries')
    })

    it('throws BridgeError(policy_invalid_return) when policy returns array with non-string elements', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: {
          pickOrder: () => (['a', 42] as unknown as readonly string[]),
        },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('policy_invalid_return')
      expect((err as Error).message).toContain('index 1')
    })

    it('throws BridgeError(duplicate_in_order) when policy returns duplicates', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: { pickOrder: () => ['a', 'a'] },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.code).toBe('duplicate_in_order')
    })

    it('wraps thrown policy error in BridgeError(policy_error)', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a', text: 'a' })],
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
        adapters: [createInProcessAdapter({ id: 'tracker', text: 'hi' })],
      })
      const result = await bridge.completeDetailed('prompt')
      expect(result.text).toBe('hi')
      expect(result.adapterId).toBe('tracker')
      expect(result.usage).toBeDefined()
    })

    it('overrides adapter-self-set adapterId with the actually-selected one', async () => {
      // Adapter sets a misleading adapterId; bridge corrects it.
      const sneaky = createInProcessAdapter({
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
        adapters: [createInProcessAdapter({ id: 'a', text: 'never reached' })],
      })
      const ctrl = new AbortController()
      ctrl.abort()
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(isAdapterError(err)).toBe(true)
      expect(err.code).toBe('aborted')
    })

    it('respects abort signal during latency', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'slow', latencyMs: 100, text: 'late' })],
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
          createInProcessAdapter({
            id: 'a',
            respond: () => {
              primaryCalls += 1
              ctrl.abort()
              throw new AdapterError('rate_limit', 'rate limited', 'a')
            },
          }),
          createInProcessAdapter({
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
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(err.code).toBe('aborted')
      // Abort attribution: should be the LAST adapter actually attempted
      // (primary 'a'), not the next one we would have tried ('b').
      expect(err.adapterId).toBe('a')
      expect(primaryCalls).toBe(1)
      expect(fallbackCalls).toBe(0)
    })
  })

  describe('post-completion abort enforcement', () => {
    it('treats result as aborted if signal aborted during adapter run', async () => {
      // Simulate an adapter that ignores the signal (common for sync
      // local libs) — returns success even after caller cancelled.
      const ctrl = new AbortController()
      const bridge = createBridge({
        adapters: [
          createInProcessAdapter({
            id: 'ignores-signal',
            respond: () => {
              ctrl.abort()  // caller cancels mid-request
              return 'should-be-discarded'
            },
          }),
        ],
      })
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('aborted')
      expect(err.adapterId).toBe('ignores-signal')
    })
  })

  describe('AbortSignal.reason preservation', () => {
    it('passes signal.reason as cause when aborting before routing', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a', text: 'x' })],
      })
      const reason = new Error('user cancelled')
      const ctrl = new AbortController()
      ctrl.abort(reason)
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('aborted')
      expect(err.cause).toBe(reason)
    })

    it('passes signal.reason when aborted between adapters', async () => {
      const ctrl = new AbortController()
      const reason = new Error('mid-flight cancel')
      const bridge = createBridge({
        adapters: [
          createInProcessAdapter({
            id: 'a',
            respond: () => {
              ctrl.abort(reason)
              throw new AdapterError('rate_limit', 'rl', 'a')
            },
          }),
          createInProcessAdapter({ id: 'b', text: 'never' }),
        ],
        primary: 'a',
        fallback: ['b'],
      })
      const err = await bridge.complete('hi', { signal: ctrl.signal }).catch((e) => e)
      expect(err.code).toBe('aborted')
      expect(err.cause).toBe(reason)
    })
  })

  describe('per-adapter concurrency limit', () => {
    it('serializes calls for adapter with maxConcurrency=1', async () => {
      let inFlight = 0
      let observedMax = 0
      const releases: Array<() => void> = []
      const slowResolve = (): Promise<string> => {
        inFlight += 1
        observedMax = Math.max(observedMax, inFlight)
        return new Promise<string>((resolve) => {
          releases.push(() => {
            inFlight -= 1
            resolve('done')
          })
        })
      }
      const adapter = createInProcessAdapter({
        id: 'serial',
        respond: slowResolve,
        metadata: { maxConcurrency: 1 } as Partial<{ maxConcurrency: number }> & Partial<{ id: string; name: string; provider: string; local: boolean }>,
      })
      // Override metadata to set maxConcurrency=1 (createInProcessAdapter
      // accepts metadata partial overrides).
      // (NB: createInProcessAdapter spreads defaults + metadata; this works.)
      const bridge = createBridge({ adapters: [adapter] })

      const p1 = bridge.complete('a')
      const p2 = bridge.complete('b')
      const p3 = bridge.complete('c')

      // Allow microtasks to settle so all calls have hit the bridge.
      await new Promise<void>((r) => setImmediate(r))
      // With maxConcurrency=1, only one should be in-flight at a time.
      expect(observedMax).toBe(1)

      // Drain.
      while (releases.length > 0) {
        const r = releases.shift()!
        r()
        // Let the next one start.
        await new Promise<void>((res) => setImmediate(res))
      }

      await Promise.all([p1, p2, p3])
      // Across the run, never more than 1 concurrent
      expect(observedMax).toBe(1)
    })

    it('allows unlimited concurrency by default', async () => {
      let inFlight = 0
      let observedMax = 0
      const releases: Array<() => void> = []
      const adapter = createInProcessAdapter({
        id: 'unlimited',
        respond: () => {
          inFlight += 1
          observedMax = Math.max(observedMax, inFlight)
          return new Promise<string>((resolve) => {
            releases.push(() => {
              inFlight -= 1
              resolve('done')
            })
          })
        },
      })
      const bridge = createBridge({ adapters: [adapter] })
      const p1 = bridge.complete('a')
      const p2 = bridge.complete('b')
      const p3 = bridge.complete('c')

      await new Promise<void>((r) => setImmediate(r))
      // No concurrency cap → all 3 should be in flight at once.
      expect(observedMax).toBe(3)

      releases.forEach((r) => r())
      await Promise.all([p1, p2, p3])
    })

    it('rejects invalid maxConcurrency at construction with invalid_adapter_metadata code', () => {
      const adapter = createInProcessAdapter({
        id: 'badcfg',
        metadata: { maxConcurrency: NaN } as Partial<{ maxConcurrency: number }>,
      })
      const err = (() => {
        try {
          createBridge({ adapters: [adapter] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toContain('maxConcurrency')
    })

    it('rejects float maxConcurrency (strict integer requirement)', () => {
      const adapter = createInProcessAdapter({
        id: 'floaty',
        metadata: { maxConcurrency: 1.5 } as Partial<{ maxConcurrency: number }>,
      })
      const err = (() => {
        try {
          createBridge({ adapters: [adapter] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toMatch(/integer/)
    })

    it('rejects maxConcurrency < 1', () => {
      const adapter = createInProcessAdapter({
        id: 'zero',
        metadata: { maxConcurrency: 0 } as Partial<{ maxConcurrency: number }>,
      })
      expect(() => createBridge({ adapters: [adapter] })).toThrow(/>= 1/)
    })

    it('sanitizes control chars in invalid maxConcurrency error message', () => {
      // Adapter with newline-laden id; bridge should escape it in the error
      const adapter = createInProcessAdapter({
        id: 'evil\nid',
        metadata: { maxConcurrency: NaN } as Partial<{ maxConcurrency: number }>,
      })
      const err = (() => {
        try {
          createBridge({ adapters: [adapter] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as Error).message).not.toMatch(/[\r\n]/)
    })

    it('aborts queued waiters when their signal fires (no slot waste)', async () => {
      const releases: Array<() => void> = []
      let invokeCount = 0
      const adapter = createInProcessAdapter({
        id: 'serial',
        metadata: { maxConcurrency: 1 } as Partial<{ maxConcurrency: number }>,
        respond: () => {
          invokeCount += 1
          return new Promise<string>((resolve) => {
            releases.push(() => resolve('done'))
          })
        },
      })
      const bridge = createBridge({ adapters: [adapter] })

      // First call holds the only slot.
      const p1 = bridge.complete('first')
      // Let the first acquire happen.
      await new Promise<void>((r) => setImmediate(r))
      expect(invokeCount).toBe(1)

      // Second call queued behind it.
      const ctrl = new AbortController()
      const p2 = bridge.complete('second', { signal: ctrl.signal })

      // Abort the queued call before its slot opens.
      ctrl.abort()
      const err = await p2.catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('aborted')
      // Adapter must not have been called for the aborted request.
      expect(invokeCount).toBe(1)

      // Drain the first call.
      releases[0]!()
      await p1
    })
  })

  describe('log injection defense', () => {
    it('sanitizes adapter id with control chars in unknown_adapter message', () => {
      // primary id contains injected control chars; bridge should
      // sanitize it before embedding in the BridgeError message.
      const evilId = 'evil\nINJECTED\rline'
      const err = (() => {
        try {
          createBridge({
            adapters: [createInProcessAdapter({ id: 'a' })],
            primary: evilId,
          })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      // No raw newlines / carriage returns leaked into the message
      expect((err as Error).message).not.toMatch(/[\r\n]/)
      // Escaped form is present
      expect((err as Error).message).toContain('\\x0a')
    })

    it('sanitizes thrown policy message', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: {
          pickOrder: () => {
            throw new Error('attack\nlog\rforge')
          },
        },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err.message).not.toMatch(/[\r\n]/)
    })
  })

  describe('policy mutation defense', () => {
    it('snapshots policy-returned order so post-return mutation is ignored', async () => {
      // Policy returns an array, then mutates it after returning.
      // The bridge must use a snapshot for iteration.
      const liveOrder: string[] = ['a', 'b']
      const bridge = createBridge({
        adapters: [
          createInProcessAdapter({ id: 'a', text: 'A' }),
          createInProcessAdapter({ id: 'b', text: 'B' }),
        ],
        policy: {
          pickOrder: () => {
            // Schedule a mutation after pickOrder returns. If the
            // bridge held the live reference, this would corrupt
            // the in-flight iteration.
            setTimeout(() => liveOrder.push('zzz'), 0)
            return liveOrder
          },
        },
      })
      const text = await bridge.complete('hi')
      expect(text).toBe('A') // primary 'a' was used; mutation didn't matter
    })
  })

  describe('API ergonomics', () => {
    it('complete works when destructured from bridge (no this binding)', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a', text: 'unbound-ok' })],
      })
      // Common consumer pattern: pull complete out as a plain function.
      const { complete } = bridge
      const text = await complete('hi')
      expect(text).toBe('unbound-ok')
    })

    it('completeDetailed also works when destructured', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a', text: 'unbound' })],
      })
      const { completeDetailed } = bridge
      const result = await completeDetailed('hi')
      expect(result.text).toBe('unbound')
      expect(result.adapterId).toBe('a')
    })
  })

  describe('introspection', () => {
    it('exposes adapterIds', () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' }), createInProcessAdapter({ id: 'b' })],
      })
      expect([...bridge.adapterIds].sort()).toEqual(['a', 'b'])
    })

    it('adapterIds is frozen (mutation rejected)', () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
      })
      expect(Object.isFrozen(bridge.adapterIds)).toBe(true)
    })

    it('getAdapter returns the adapter or undefined', () => {
      const a = createInProcessAdapter({ id: 'a' })
      const bridge = createBridge({ adapters: [a] })
      expect(bridge.getAdapter('a')).toBe(a)
      expect(bridge.getAdapter('nope')).toBeUndefined()
    })
  })

  describe('safe error stringification', () => {
    it('handles adapter throwing object whose toString itself throws', async () => {
      const adversarial = {
        toString() {
          throw new Error('toString attack')
        },
      }
      const bridge = createBridge({
        adapters: [
          createInProcessAdapter({
            id: 'a',
            respond: () => {
              throw adversarial
            },
          }),
        ],
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('unknown')
      // Should not have crashed; some defensive string is present.
      expect(typeof err.message).toBe('string')
    })

    it('handles policy throwing object whose toString itself throws', async () => {
      const bridge = createBridge({
        adapters: [createInProcessAdapter({ id: 'a' })],
        policy: {
          pickOrder: () => {
            const evil = {
              toString() {
                throw new Error('attack')
              },
            }
            // Throw a non-Error so we hit safeToString path
            throw evil as unknown as Error
          },
        },
      })
      const err = await bridge.complete('hi').catch((e) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('policy_error')
      expect(typeof err.message).toBe('string')
    })
  })

  describe('metadata shape validation', () => {
    it('rejects non-string id', () => {
      const bad = {
        metadata: { id: 42, name: 'x', provider: 'other', local: true } as unknown as { id: string; name: string; provider: 'other'; local: boolean },
        async complete() {
          return { text: '' }
        },
      }
      const err = (() => {
        try {
          createBridge({ adapters: [bad as unknown as Parameters<typeof createBridge>[0]['adapters'][number]] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
    })

    it('rejects adapter without complete function', () => {
      const bad = {
        metadata: { id: 'x', name: 'X', provider: 'other', local: true },
      }
      const err = (() => {
        try {
          createBridge({ adapters: [bad as unknown as Parameters<typeof createBridge>[0]['adapters'][number]] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toContain('complete must be a function')
    })

    it('rejects null adapter', () => {
      const err = (() => {
        try {
          createBridge({ adapters: [null as unknown as Parameters<typeof createBridge>[0]['adapters'][number]] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
    })

    it('rejects missing metadata', () => {
      const bad = { metadata: undefined, async complete() { return { text: '' } } }
      const err = (() => {
        try {
          createBridge({ adapters: [bad as unknown as Parameters<typeof createBridge>[0]['adapters'][number]] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
    })

    it('rejects non-boolean local', () => {
      const bad = {
        metadata: { id: 'x', name: 'x', provider: 'other', local: 'yes' },
        async complete() { return { text: '' } },
      }
      const err = (() => {
        try {
          createBridge({ adapters: [bad as unknown as Parameters<typeof createBridge>[0]['adapters'][number]] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toContain('local')
    })
  })

  describe('per-adapter-instance concurrency (WeakMap)', () => {
    it('rejects when maxConcurrency drifts from set to undefined', () => {
      const adapter = createInProcessAdapter({
        id: 'drift-undef',
        metadata: { maxConcurrency: 1 } as Partial<{ maxConcurrency: number }>,
      })
      createBridge({ adapters: [adapter] }) // first registration: max=1

      // Mutate metadata to undefined
      const mutable = adapter as { metadata: { maxConcurrency?: number } }
      delete mutable.metadata.maxConcurrency
      const err = (() => {
        try {
          createBridge({ adapters: [adapter] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toContain('previously registered')
    })

    it('rejects conflicting maxConcurrency on second bridge for same adapter', () => {
      // First bridge registers adapter with max=1; second tries max=2 → conflict.
      // Note: since the in-process adapter's metadata is constructed at
      // create time, we mutate after first registration to simulate drift.
      const adapter = createInProcessAdapter({
        id: 'conflict-test',
        metadata: { maxConcurrency: 1 } as Partial<{ maxConcurrency: number }>,
      })
      createBridge({ adapters: [adapter] }) // first registration: max=1

      // Mutate metadata to simulate drift, then re-register
      const mutable = adapter as { metadata: { maxConcurrency?: number } }
      Object.defineProperty(mutable.metadata, 'maxConcurrency', {
        value: 2,
        writable: true,
        configurable: true,
      })
      const err = (() => {
        try {
          createBridge({ adapters: [adapter] })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('invalid_adapter_metadata')
      expect((err as Error).message).toContain('previously registered')
    })

    it('shares concurrency limit when same adapter is registered with two bridges', async () => {
      let inFlight = 0
      let observedMax = 0
      const releases: Array<() => void> = []
      const adapter = createInProcessAdapter({
        id: 'shared',
        metadata: { maxConcurrency: 1 } as Partial<{ maxConcurrency: number }>,
        respond: () => {
          inFlight += 1
          observedMax = Math.max(observedMax, inFlight)
          return new Promise<string>((resolve) => {
            releases.push(() => {
              inFlight -= 1
              resolve('done')
            })
          })
        },
      })

      // Two bridges share the same adapter object.
      const bridgeA = createBridge({ adapters: [adapter] })
      const bridgeB = createBridge({ adapters: [adapter] })

      const p1 = bridgeA.complete('a')
      const p2 = bridgeB.complete('b')

      await new Promise<void>((r) => setImmediate(r))
      // Despite two bridges, observed concurrency stays at 1.
      expect(observedMax).toBe(1)

      // Drain.
      while (releases.length > 0) {
        releases.shift()!()
        await new Promise<void>((r) => setImmediate(r))
      }
      await Promise.all([p1, p2])
      expect(observedMax).toBe(1)
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

  it('matches when name is empty string on Error instance', () => {
    const fake = Object.assign(new Error('msg'), {
      name: '',
      code: 'network' as AdapterErrorCode,
    })
    expect(isAdapterError(fake)).toBe(true)
  })

  it('rejects plain object with right shape but no Error prototype', () => {
    const plain = { code: 'rate_limit' as AdapterErrorCode, message: 'msg' }
    expect(isAdapterError(plain)).toBe(false)
  })

  it('rejects when name is set to something unrelated', () => {
    // Don't be fooled by random Errors that happened to get a `code`.
    const fake = Object.assign(new TypeError('typeerr'), { code: 'rate_limit' })
    fake.name = 'TypeError'
    expect(isAdapterError(fake)).toBe(false)
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

describe('@auraaihq/ai-bridge sanitization', () => {
  it('error messages with adversarial content stay bounded and printable', async () => {
    const massive = '\n'.repeat(50000) + 'x'.repeat(50000)
    const bridge = createBridge({
      adapters: [
        createInProcessAdapter({
          id: 'a',
          respond: () => {
            throw new Error(massive)
          },
        }),
      ],
    })
    const err = await bridge.complete('hi').catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.message.length).toBeLessThanOrEqual(200)
    expect(err.message).not.toMatch(/[\r\n]/)
  })

  it('isAdapterError rejects plain objects without Error prototype', () => {
    // Right shape but NOT an Error instance (e.g., from JSON-deserialized
    // remote payload masquerading as an error).
    const plainObject = { name: 'AdapterError', code: 'rate_limit' as const, message: 'msg' }
    expect(isAdapterError(plainObject)).toBe(false)
  })

  it('toAdapterError always returns a real Error instance', async () => {
    // Cross-realm AdapterError-shaped object that's NOT an Error.
    const fakeError = Object.assign(Object.create(null), {
      name: 'AdapterError',
      code: 'rate_limit',
      message: 'fake',
    })
    let capturedThrow: unknown
    const bridge = createBridge({
      adapters: [
        createInProcessAdapter({
          id: 'a',
          respond: () => {
            capturedThrow = fakeError
            throw fakeError as unknown as Error
          },
        }),
      ],
    })
    const err = await bridge.complete('hi').catch((e) => e)
    // Bridge must have wrapped to a real Error instance, NOT returned
    // the bare fakeError.
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBe(capturedThrow)
  })
})

describe('@auraaihq/ai-bridge in-process adapter', () => {
  it('returns text from `text` option', async () => {
    const a = createInProcessAdapter({ text: 'hello' })
    const result = await a.complete('prompt')
    expect(result.text).toBe('hello')
  })

  it('returns text from `respond` callback', async () => {
    const a = createInProcessAdapter({ respond: (p) => p.toUpperCase() })
    const result = await a.complete('hi there')
    expect(result.text).toBe('HI THERE')
  })

  it('uses default templated text when nothing provided', async () => {
    const a = createInProcessAdapter({ id: 'd' })
    const result = await a.complete('q')
    expect(result.text).toBe('[d] q')
  })

  it('throws AdapterError with the configured code', async () => {
    const a = createInProcessAdapter({ throwCode: 'rate_limit' })
    const err = await a.complete('hi').catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.code).toBe('rate_limit')
  })

  it('reports usage tokens (rough estimate)', async () => {
    const a = createInProcessAdapter({ text: 'response' })
    const result = await a.complete('input prompt')
    expect(result.usage?.promptTokens).toBe(Math.ceil('input prompt'.length / 4))
    expect(result.usage?.completionTokens).toBe(Math.ceil('response'.length / 4))
  })

  it('rejects immediately when signal already aborted (deterministic, fake timers)', async () => {
    vi.useFakeTimers()
    try {
      const ctrl = new AbortController()
      ctrl.abort()
      const a = createInProcessAdapter({ latencyMs: 5000, text: 'unreachable' })
      // Don't await yet — we want to assert it settles WITHOUT advancing timers.
      const promise = a.complete('hi', { signal: ctrl.signal })
      const err = await promise.catch((e) => e)
      expect(err).toBeInstanceOf(AdapterError)
      expect(err.code).toBe('aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up abort listener on success path — listener add/remove balance', async () => {
    // Track add/remove calls on the signal directly.
    const ctrl = new AbortController()
    const addSpy = vi.spyOn(ctrl.signal, 'addEventListener')
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener')

    const a = createInProcessAdapter({ latencyMs: 10, text: 'ok' })
    const result = await a.complete('hi', { signal: ctrl.signal })
    expect(result.text).toBe('ok')

    // For each addEventListener('abort', …), there must be a matching
    // removeEventListener('abort', …) — proving cleanup ran.
    const adds = addSpy.mock.calls.filter((c) => c[0] === 'abort').length
    const removes = removeSpy.mock.calls.filter((c) => c[0] === 'abort').length
    expect(adds).toBeGreaterThan(0)
    expect(removes).toBe(adds)
  })

  it('catches abort fired immediately after listener attach (race window)', async () => {
    // This test exercises the post-attach re-check: we abort *between*
    // the addEventListener call and the timer's tick. With pre-check
    // only, this could miss; with post-check, it must catch.
    const ctrl = new AbortController()
    const a = createInProcessAdapter({ latencyMs: 50, text: 'unreachable' })
    // Schedule abort to fire on the next microtask (after the listener
    // has been attached but possibly before the AbortController would
    // synchronously dispatch).
    queueMicrotask(() => ctrl.abort())
    const err = await a.complete('hi', { signal: ctrl.signal }).catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.code).toBe('aborted')
  })
})
