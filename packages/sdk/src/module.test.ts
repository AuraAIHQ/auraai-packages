import { describe, it, expect } from 'vitest'
import { defineModule, type Module, type Intent, type Result } from './module'

// A minimal module used to exercise the type contract end-to-end.
function makeTestModule(): Module {
  let loadCount = 0
  let unloadCount = 0

  return defineModule({
    manifest: {
      id: 'test-module',
      version: '0.1.0',
      name: 'Test Module',
      description: 'Test fixture',
      permissions: ['memory:read', 'memory:write'],
    },
    async load(ctx) {
      loadCount += 1
      ctx.log.debug('loaded')
    },
    async unload() {
      unloadCount += 1
    },
    async invoke(intent, _ctx) {
      if (intent.kind === 'echo') {
        return { ok: true, data: intent.payload }
      }
      return {
        ok: false,
        error: { code: 'unknown_intent', message: `unknown kind: ${intent.kind}` },
      }
    },
  }) as Module & { _counts: () => { load: number; unload: number } }
}

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('@auraaihq/sdk module contract', () => {
  it('defineModule returns the same object (type helper only)', () => {
    const mod = defineModule({
      manifest: {
        id: 'x',
        version: '0.0.0',
        name: 'X',
        description: '',
        permissions: [],
      },
      async load() {},
      async unload() {},
      async invoke() {
        return { ok: true, data: null }
      },
    })
    expect(mod.manifest.id).toBe('x')
  })

  it('lifecycle: load → invoke → unload', async () => {
    const mod = makeTestModule()
    const ctx = {
      manifest: mod.manifest,
      log: noopLog,
    }
    await mod.load(ctx)
    const result = await mod.invoke({ kind: 'echo', payload: { hello: 'world' } }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ hello: 'world' })
    }
    await mod.unload()
  })

  it('invoke returns error result for unknown intent kind', async () => {
    const mod = makeTestModule()
    const ctx = { manifest: mod.manifest, log: noopLog }
    const result = await mod.invoke({ kind: 'nope', payload: null }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_intent')
    }
  })

  it('manifest.permissions is a readonly array (compile-time constraint)', () => {
    const mod = makeTestModule()
    expect(Array.isArray(mod.manifest.permissions)).toBe(true)
    // Verify intent shape contract holds at runtime
    const intent: Intent<string> = { kind: 'echo', payload: 'hi' }
    expect(intent.kind).toBe('echo')
  })

  it('Result type narrows correctly via discriminant', () => {
    const success: Result<number> = { ok: true, data: 42 }
    const failure: Result<number> = {
      ok: false,
      error: { code: 'oops', message: 'bad' },
    }

    if (success.ok) {
      expect(success.data).toBe(42)
    }
    if (!failure.ok) {
      expect(failure.error.message).toBe('bad')
    }
  })
})
