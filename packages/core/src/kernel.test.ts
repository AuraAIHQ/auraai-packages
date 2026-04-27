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
      // Verify the underlying memory got the namespaced row
      expect(memory.get('m:test')).toBe(1)
      // And the module's view sees it under its own key
      expect(capturedMem!.get('test')).toBe(1)
    })

    it('memory:read only — set/delete throw', async () => {
      let capturedMem: ReturnType<typeof makeReadOnlyAccess> = null as unknown as ReturnType<typeof makeReadOnlyAccess>
      kernel.register(
        makeModule('readonly', {
          permissions: ['memory:read'],
          onLoad: (ctx) => {
            capturedMem = makeReadOnlyAccess(ctx.memory!)
          },
        }),
      )
      await kernel.load('readonly')
      memory.set('readonly:seed', 'hello')
      expect(capturedMem.get('seed')).toBe('hello')
      expect(() => capturedMem.set('x', 1)).toThrow(/memory:write/)
      expect(() => capturedMem.delete('x')).toThrow(/memory:write/)
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
  })
})

// Helper: forwards memory handle methods so tests can assert each call.
function makeReadOnlyAccess(handle: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; delete: (k: string) => void }) {
  return handle
}
