import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMemory, type Memory } from '@auraaihq/memory'
import { defineModule, type Module, type Permission } from '@auraaihq/sdk'
import {
  createKernel,
  type Kernel,
  CycleError,
  UnknownModuleError,
  NotLoadedError,
} from './kernel'

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeModule(
  id: string,
  options: {
    deps?: string[]
    permissions?: Permission[]
    onLoad?: (ctx: Parameters<Module['load']>[0]) => void | Promise<void>
    onUnload?: () => void | Promise<void>
    onInvoke?: Module['invoke']
  } = {},
): Module {
  return defineModule({
    manifest: {
      id,
      version: '0.1.0',
      sdkVersion: '0.1.0',
      name: id,
      description: `test module ${id}`,
      permissions: options.permissions ?? [],
      dependencies: options.deps,
    },
    async load(ctx) {
      await options.onLoad?.(ctx)
    },
    async unload() {
      await options.onUnload?.()
    },
    async invoke(intent, ctx) {
      if (options.onInvoke) return options.onInvoke(intent, ctx)
      return { ok: true, data: { id, intent: intent.kind } }
    },
  })
}

describe('@auraaihq/core kernel', () => {
  let memory: Memory
  let kernel: Kernel

  beforeEach(() => {
    memory = createMemory({ filename: ':memory:' })
    kernel = createKernel({ memory, log: silentLog })
  })

  afterEach(async () => {
    await kernel.shutdown()
    memory.close()
  })

  describe('register', () => {
    it('adds modules to the registry', () => {
      const m = makeModule('a')
      kernel.register(m)
      expect(kernel.has('a')).toBe(true)
      expect(kernel.list().get('a')?.state).toBe('registered')
    })

    it('is idempotent for the same instance', () => {
      const m = makeModule('a')
      kernel.register(m)
      expect(() => kernel.register(m)).not.toThrow()
    })

    it('refuses silent override with a different instance', () => {
      const m1 = makeModule('a')
      const m2 = makeModule('a')
      kernel.register(m1)
      expect(() => kernel.register(m2)).toThrow(/refusing silent override/)
    })
  })

  describe('load', () => {
    it('loads a single module with no deps', async () => {
      const onLoad = vi.fn()
      kernel.register(makeModule('a', { onLoad }))
      await kernel.load('a')
      expect(onLoad).toHaveBeenCalledOnce()
      expect(kernel.list().get('a')?.state).toBe('loaded')
    })

    it('throws UnknownModuleError for missing id', async () => {
      await expect(kernel.load('nope')).rejects.toBeInstanceOf(UnknownModuleError)
    })

    it('loads dependencies before dependents', async () => {
      const order: string[] = []
      kernel.register(makeModule('lib', { onLoad: () => { order.push('lib') } }))
      kernel.register(
        makeModule('app', {
          deps: ['lib'],
          onLoad: () => { order.push('app') },
        }),
      )
      await kernel.load('app')
      expect(order).toEqual(['lib', 'app'])
    })

    it('rejects load when dep is not registered', async () => {
      kernel.register(makeModule('app', { deps: ['missing-lib'] }))
      await expect(kernel.load('app')).rejects.toBeInstanceOf(UnknownModuleError)
    })

    it('records load failure and rethrows', async () => {
      kernel.register(
        makeModule('bad', {
          onLoad: () => {
            throw new Error('boom')
          },
        }),
      )
      await expect(kernel.load('bad')).rejects.toThrow('boom')
      expect(kernel.list().get('bad')?.state).toBe('failed')
      expect(kernel.list().get('bad')?.error?.message).toBe('boom')
    })

    it('is idempotent for already-loaded modules', async () => {
      const onLoad = vi.fn()
      kernel.register(makeModule('a', { onLoad }))
      await kernel.load('a')
      await kernel.load('a') // second call should be no-op
      expect(onLoad).toHaveBeenCalledOnce()
    })

    it('re-load of failed module rethrows captured error (no silent retry)', async () => {
      let attempts = 0
      kernel.register(
        makeModule('bad', {
          onLoad: () => {
            attempts += 1
            throw new Error('boom')
          },
        }),
      )
      await expect(kernel.load('bad')).rejects.toThrow('boom')
      // Second call should NOT call onLoad again — it should re-throw
      // the captured error.
      await expect(kernel.load('bad')).rejects.toThrow('boom')
      expect(attempts).toBe(1)
    })

    it('retry() resets failed state, allowing fresh load attempt', async () => {
      let attempts = 0
      let shouldFail = true
      kernel.register(
        makeModule('flaky', {
          onLoad: () => {
            attempts += 1
            if (shouldFail) throw new Error('first time')
          },
        }),
      )
      await expect(kernel.load('flaky')).rejects.toThrow()
      // Reset and retry — onLoad runs again, this time succeeds.
      shouldFail = false
      kernel.retry('flaky')
      expect(kernel.list().get('flaky')?.state).toBe('registered')
      await kernel.load('flaky')
      expect(kernel.list().get('flaky')?.state).toBe('loaded')
      expect(attempts).toBe(2)
    })

    it('retry() throws UnknownModuleError for unregistered id', () => {
      expect(() => kernel.retry('nope')).toThrow(/unknown module/)
    })

    it('retry() is no-op for non-failed modules', async () => {
      kernel.register(makeModule('a'))
      await kernel.load('a')
      expect(() => kernel.retry('a')).not.toThrow()
      expect(kernel.list().get('a')?.state).toBe('loaded')
    })

    it('concurrent load() calls for same id coalesce into one', async () => {
      let onLoadCalls = 0
      kernel.register(
        makeModule('slow', {
          onLoad: async () => {
            onLoadCalls += 1
            // small delay so the second call observes the first in-flight
            await new Promise((r) => setTimeout(r, 10))
          },
        }),
      )
      const [r1, r2, r3] = await Promise.all([
        kernel.load('slow'),
        kernel.load('slow'),
        kernel.load('slow'),
      ])
      expect(onLoadCalls).toBe(1)
      expect(r1.state).toBe('loaded')
      expect(r2.state).toBe('loaded')
      expect(r3.state).toBe('loaded')
    })
  })

  describe('sdkVersion validation', () => {
    it('accepts compatible sdkVersion', () => {
      const mod = makeModule('compat')
      // makeModule sets sdkVersion: '0.1.0' which matches kernel's '0.1' range
      expect(() => kernel.register(mod)).not.toThrow()
    })

    it('accepts caret-prefixed sdkVersion', () => {
      const mod = defineModule({
        manifest: {
          id: 'caret',
          version: '0.0.0',
          sdkVersion: '^0.1.5',
          name: 'caret',
          description: '',
          permissions: [],
        },
        async load() {},
        async unload() {},
        async invoke() {
          return { ok: true, data: null }
        },
      })
      expect(() => kernel.register(mod)).not.toThrow()
    })

    it('rejects incompatible sdkVersion (different major.minor)', () => {
      const mod = defineModule({
        manifest: {
          id: 'incompat',
          version: '0.0.0',
          sdkVersion: '2.0.0',
          name: 'incompat',
          description: '',
          permissions: [],
        },
        async load() {},
        async unload() {},
        async invoke() {
          return { ok: true, data: null }
        },
      })
      expect(() => kernel.register(mod)).toThrow(/sdkVersion/)
    })

    it('warns but accepts module without sdkVersion declaration', () => {
      const calls: string[] = []
      const k = createKernel({
        memory,
        log: {
          debug: () => {},
          info: () => {},
          warn: (msg) => calls.push(String(msg)),
          error: () => {},
        },
      })
      const mod = defineModule({
        manifest: {
          id: 'legacy',
          version: '0.0.0',
          name: 'legacy',
          description: '',
          permissions: [],
        },
        async load() {},
        async unload() {},
        async invoke() {
          return { ok: true, data: null }
        },
      })
      expect(() => k.register(mod)).not.toThrow()
      expect(calls.some((m) => m.includes('sdkVersion'))).toBe(true)
    })
  })

  describe('loadAll', () => {
    it('loads all modules in topo order', async () => {
      const order: string[] = []
      kernel.register(makeModule('c', { deps: ['b'], onLoad: () => { order.push('c') } }))
      kernel.register(makeModule('b', { deps: ['a'], onLoad: () => { order.push('b') } }))
      kernel.register(makeModule('a', { onLoad: () => { order.push('a') } }))
      const result = await kernel.loadAll()
      expect(result.loaded).toEqual(['a', 'b', 'c'])
      expect(result.failed).toEqual([])
      expect(order).toEqual(['a', 'b', 'c'])
    })

    it('detects dependency cycles', async () => {
      kernel.register(makeModule('a', { deps: ['b'] }))
      kernel.register(makeModule('b', { deps: ['a'] }))
      await expect(kernel.loadAll()).rejects.toBeInstanceOf(CycleError)
    })

    it('stops on first failure by default', async () => {
      kernel.register(makeModule('a'))
      kernel.register(
        makeModule('b', {
          onLoad: () => {
            throw new Error('b boom')
          },
        }),
      )
      kernel.register(makeModule('c'))
      const result = await kernel.loadAll()
      expect(result.failed.map((f) => f.id)).toEqual(['b'])
      // c should not have been loaded due to early stop
      expect(result.loaded.includes('c')).toBe(false)
    })

    it('continues past failures with continueOnError', async () => {
      kernel.register(makeModule('a'))
      kernel.register(
        makeModule('b', {
          onLoad: () => {
            throw new Error('b boom')
          },
        }),
      )
      kernel.register(makeModule('c'))
      const result = await kernel.loadAll({ continueOnError: true })
      expect(result.loaded.sort()).toEqual(['a', 'c'])
      expect(result.failed.map((f) => f.id)).toEqual(['b'])
    })
  })

  describe('invoke', () => {
    it('routes to module and returns its Result', async () => {
      kernel.register(
        makeModule('echo', {
          onInvoke: async (intent) => ({ ok: true, data: { echoed: intent.payload } }),
        }),
      )
      await kernel.load('echo')
      const result = await kernel.invoke('echo', { kind: 'do', payload: 'hi' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toEqual({ echoed: 'hi' })
      }
    })

    it('throws when module is not loaded', async () => {
      kernel.register(makeModule('lazy'))
      await expect(
        kernel.invoke('lazy', { kind: 'x', payload: null }),
      ).rejects.toBeInstanceOf(NotLoadedError)
    })

    it('throws UnknownModuleError for unregistered id', async () => {
      await expect(
        kernel.invoke('nope', { kind: 'x', payload: null }),
      ).rejects.toBeInstanceOf(UnknownModuleError)
    })
  })

  describe('unload', () => {
    it('calls module unload hook', async () => {
      const onUnload = vi.fn()
      kernel.register(makeModule('a', { onUnload }))
      await kernel.load('a')
      await kernel.unload('a')
      expect(onUnload).toHaveBeenCalledOnce()
      expect(kernel.list().get('a')?.state).toBe('unloaded')
    })

    it('unloads dependents before the dep itself', async () => {
      const order: string[] = []
      kernel.register(makeModule('lib', { onUnload: () => { order.push('lib') } }))
      kernel.register(
        makeModule('app', {
          deps: ['lib'],
          onUnload: () => { order.push('app') },
        }),
      )
      await kernel.load('app')
      await kernel.unload('lib')
      expect(order).toEqual(['app', 'lib'])
    })

    it('is no-op for non-loaded modules', async () => {
      const onUnload = vi.fn()
      kernel.register(makeModule('a', { onUnload }))
      await kernel.unload('a')
      expect(onUnload).not.toHaveBeenCalled()
    })
  })

  describe('memory permissions', () => {
    it('passes namespaced memory when module declares memory:read+write', async () => {
      let capturedMem: { get: (k: string) => unknown; set: (k: string, v: unknown) => void } | undefined
      kernel.register(
        makeModule('m', {
          permissions: ['memory:read', 'memory:write'],
          onLoad: (ctx) => {
            capturedMem = ctx.memory!
            ctx.memory!.set('test', 1)
          },
        }),
      )
      await kernel.load('m')
      // Verify the underlying memory got the namespaced row by going
      // through the same namespace (root memory.get('m:test') would
      // throw since keys can't contain ':').
      expect(memory.namespace('m').get('test')).toBe(1)
      // And the module's view sees it under its own key
      expect(capturedMem!.get('test')).toBe(1)
    })

    it('memory:read only — set/delete throw', async () => {
      let capturedMem: { get(k: string): unknown; set(k: string, v: unknown): void; delete(k: string): void } | undefined
      kernel.register(
        makeModule('readonly', {
          permissions: ['memory:read'],
          onLoad: (ctx) => {
            capturedMem = ctx.memory!
          },
        }),
      )
      await kernel.load('readonly')
      // Seed via the underlying namespaced memory (direct ':' keys
      // on root are now rejected to prevent collision footguns).
      memory.namespace('readonly').set('seed', 'hello')
      expect(capturedMem!.get('seed')).toBe('hello')
      expect(() => capturedMem!.set('x', 1)).toThrow(/memory:write/)
      expect(() => capturedMem!.delete('x')).toThrow(/memory:write/)
    })

    it('no memory permissions — ctx.memory is undefined', async () => {
      let captured: unknown = 'unset'
      kernel.register(
        makeModule('no-mem', {
          onLoad: (ctx) => {
            captured = ctx.memory
          },
        }),
      )
      await kernel.load('no-mem')
      expect(captured).toBeUndefined()
    })
  })

  describe('shutdown', () => {
    it('unloads all in reverse load order', async () => {
      const order: string[] = []
      kernel.register(makeModule('a', { onUnload: () => { order.push('a') } }))
      kernel.register(makeModule('b', { onUnload: () => { order.push('b') } }))
      kernel.register(makeModule('c', { onUnload: () => { order.push('c') } }))
      await kernel.loadAll()
      await kernel.shutdown()
      // load order is a, b, c so unload should be c, b, a
      expect(order).toEqual(['c', 'b', 'a'])
    })

    it('continues past unload errors', async () => {
      kernel.register(makeModule('a'))
      kernel.register(
        makeModule('b', {
          onUnload: () => {
            throw new Error('b unload boom')
          },
        }),
      )
      await kernel.loadAll()
      // Should not throw
      await expect(kernel.shutdown()).resolves.toBeUndefined()
    })

    it('idempotent: second shutdown is no-op', async () => {
      kernel.register(makeModule('a'))
      await kernel.loadAll()
      await kernel.shutdown()
      await expect(kernel.shutdown()).resolves.toBeUndefined()
    })

    it('rejects new register/load/loadAll after shutdown started', async () => {
      kernel.register(makeModule('a'))
      await kernel.shutdown()
      expect(() => kernel.register(makeModule('b'))).toThrow(/shutting down/)
      await expect(kernel.load('a')).rejects.toThrow(/shutting down/)
      await expect(kernel.loadAll()).rejects.toThrow(/shutting down/)
    })

    it('waits for in-flight load to settle before unloading', async () => {
      let phase = 'idle'
      kernel.register(
        makeModule('slow', {
          onLoad: async () => {
            phase = 'loading'
            await new Promise((r) => setTimeout(r, 30))
            phase = 'loaded'
          },
        }),
      )
      const loadPromise = kernel.load('slow')
      // Start shutdown while load is in flight.
      const shutdownPromise = kernel.shutdown()
      await Promise.all([loadPromise.catch(() => {}), shutdownPromise])
      // After shutdown, the slow module should have either finished
      // loading then been unloaded, OR been kept in 'loading'/'failed'
      // — but never in a mid-state at shutdown's resolution.
      const final = kernel.list().get('slow')?.state
      expect(['unloaded', 'loaded', 'failed'].includes(final ?? '')).toBe(true)
    })
  })

  describe('ModuleContext stability (per SDK contract)', () => {
    it('same ctx instance is reused across invoke() calls', async () => {
      const observed: unknown[] = []
      kernel.register(
        makeModule('m', {
          permissions: ['memory:read', 'memory:write'],
          onInvoke: async (_intent, ctx) => {
            observed.push(ctx)
            return { ok: true, data: null }
          },
        }),
      )
      await kernel.load('m')
      await kernel.invoke('m', { kind: 'a', payload: null })
      await kernel.invoke('m', { kind: 'b', payload: null })
      await kernel.invoke('m', { kind: 'c', payload: null })
      expect(observed).toHaveLength(3)
      // All three invokes saw the SAME ctx reference.
      expect(observed[0]).toBe(observed[1])
      expect(observed[1]).toBe(observed[2])
    })

    it('ctx passed to load() is the same one passed to invoke()', async () => {
      let loadCtx: unknown
      let invokeCtx: unknown
      kernel.register(
        makeModule('m', {
          permissions: ['memory:read'],
          onLoad: (ctx) => {
            loadCtx = ctx
          },
          onInvoke: async (_intent, ctx) => {
            invokeCtx = ctx
            return { ok: true, data: null }
          },
        }),
      )
      await kernel.load('m')
      await kernel.invoke('m', { kind: 'x', payload: null })
      expect(loadCtx).toBe(invokeCtx)
    })

    it('ctx is cleared after unload, so post-unload invoke fails clean', async () => {
      kernel.register(makeModule('m'))
      await kernel.load('m')
      await kernel.unload('m')
      await expect(
        kernel.invoke('m', { kind: 'x', payload: null }),
      ).rejects.toThrow(/not loaded/)
    })
  })
})

