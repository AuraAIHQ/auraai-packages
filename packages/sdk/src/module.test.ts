import { describe, it, expect } from 'vitest'
import {
  defineModule,
  type Module,
  type Intent,
  type Result,
  type ModuleLifecycle,
  type AICompletionResult,
} from './module'

// A minimal module used to exercise the type contract end-to-end.
function makeTestModule(): Module {
  return defineModule({
    manifest: {
      id: 'test-module',
      version: '0.1.0',
      sdkVersion: '^0.1.0',
      name: 'Test Module',
      description: 'Test fixture',
      permissions: ['memory:read', 'memory:write'],
      intents: ['echo'],
      lifecycle: 'on-demand',
    },
    async load(ctx) {
      ctx.log.debug('loaded')
    },
    async unload() {},
    async invoke(intent, _ctx) {
      if (intent.kind === 'echo') {
        return { ok: true, data: intent.payload }
      }
      return {
        ok: false,
        error: { code: 'unknown_intent', message: `unknown kind: ${intent.kind}` },
      }
    },
  })
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

  describe('manifest extensions (M1 review additions)', () => {
    it('accepts sdkVersion field', () => {
      const mod = makeTestModule()
      expect(mod.manifest.sdkVersion).toBe('^0.1.0')
    })

    it('accepts intents field listing handled kinds', () => {
      const mod = makeTestModule()
      expect(mod.manifest.intents).toEqual(['echo'])
    })

    it('accepts lifecycle field', () => {
      const mod = makeTestModule()
      expect(mod.manifest.lifecycle).toBe('on-demand')
    })

    it('lifecycle accepts persistent / on-demand / ephemeral', () => {
      const lifecycles: ModuleLifecycle[] = ['persistent', 'on-demand', 'ephemeral']
      for (const lc of lifecycles) {
        const mod = defineModule({
          manifest: {
            id: 'l',
            version: '0.0.0',
            name: 'l',
            description: '',
            permissions: [],
            lifecycle: lc,
          },
          async load() {},
          async unload() {},
          async invoke() {
            return { ok: true, data: null }
          },
        })
        expect(mod.manifest.lifecycle).toBe(lc)
      }
    })

    it('manifest fields are all optional except required ones', () => {
      // Module with minimal required manifest still type-checks.
      const minimal = defineModule({
        manifest: {
          id: 'minimal',
          version: '0.0.1',
          name: 'Minimal',
          description: '',
          permissions: [],
        },
        async load() {},
        async unload() {},
        async invoke() {
          return { ok: true, data: null }
        },
      })
      expect(minimal.manifest.intents).toBeUndefined()
      expect(minimal.manifest.lifecycle).toBeUndefined()
      expect(minimal.manifest.sdkVersion).toBeUndefined()
      expect(minimal.manifest.dependencies).toBeUndefined()
    })
  })

  describe('typed intent narrowing (generic Module)', () => {
    type PublishIntent =
      | Intent<'publish', { md: string; title: string }>
      | Intent<'preview', { md: string }>

    it('Module<TIntent> narrows intent.payload by intent.kind in invoke', async () => {
      let observedTitle: string | undefined
      let observedPreviewMd: string | undefined

      const mod = defineModule<PublishIntent>({
        manifest: {
          id: 'publish',
          version: '0.1.0',
          name: 'Publish',
          description: '',
          permissions: [],
          intents: ['publish', 'preview'],
        },
        async load() {},
        async unload() {},
        async invoke(intent, _ctx) {
          // TypeScript narrows intent.payload here based on intent.kind.
          if (intent.kind === 'publish') {
            observedTitle = intent.payload.title
            return { ok: true, data: { url: `https://blog/${intent.payload.title}` } }
          }
          if (intent.kind === 'preview') {
            observedPreviewMd = intent.payload.md
            return { ok: true, data: { html: '<p>preview</p>' } }
          }
          return { ok: false, error: { code: 'unreachable', message: '' } }
        },
      })

      const ctx = { manifest: mod.manifest, log: noopLog }
      const r1 = await mod.invoke(
        { kind: 'publish', payload: { md: '# hi', title: 'hello' } },
        ctx,
      )
      expect(r1.ok).toBe(true)
      expect(observedTitle).toBe('hello')

      const r2 = await mod.invoke({ kind: 'preview', payload: { md: '# yo' } }, ctx)
      expect(r2.ok).toBe(true)
      expect(observedPreviewMd).toBe('# yo')
    })
  })

  describe('AICompletionResult type', () => {
    it('shape includes text + optional usage + optional adapterId', () => {
      const r1: AICompletionResult = { text: 'hi' }
      const r2: AICompletionResult = {
        text: 'hi',
        usage: { promptTokens: 10, completionTokens: 5 },
        adapterId: 'claude',
      }
      expect(r1.text).toBe('hi')
      expect(r2.adapterId).toBe('claude')
    })
  })

  describe('ModuleContext lifecycle invariants (documented)', () => {
    it('same ctx instance is suitable for both load() and invoke()', async () => {
      const mod = makeTestModule()
      const ctx = { manifest: mod.manifest, log: noopLog }
      await mod.load(ctx)
      // The kernel passes the SAME ctx — calling invoke with the same
      // reference should work and produce consistent results.
      const r1 = await mod.invoke({ kind: 'echo', payload: 1 }, ctx)
      const r2 = await mod.invoke({ kind: 'echo', payload: 2 }, ctx)
      expect(r1.ok && r1.data).toBe(1)
      expect(r2.ok && r2.data).toBe(2)
      await mod.unload()
    })
  })
})
