import { describe, it, expect } from 'vitest'
import {
  defineModule,
  type Module,
  type Intent,
  type Result,
  type ModuleLifecycle,
  type ModuleType,
  type ModuleNavItem,
  type ContainerConfig,
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
        sdkVersion: '^0.1.0',
        name: 'X',
        description: 'smoke test module',
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

  describe('defineModule validates manifest fields at runtime', () => {
    const base = {
      async load() {},
      async unload() {},
      async invoke() { return { ok: true as const, data: null } },
    }

    it('throws when id is missing', () => {
      expect(() => defineModule({ ...base, manifest: { id: '', version: '0.0.0', sdkVersion: '^0.1.0', name: 'X', description: 'x', permissions: [] } }))
        .toThrow(TypeError)
    })

    it('throws when version is missing', () => {
      expect(() => defineModule({ ...base, manifest: { id: 'x', version: '', sdkVersion: '^0.1.0', name: 'X', description: 'x', permissions: [] } }))
        .toThrow(TypeError)
    })

    it('throws when name is missing', () => {
      expect(() => defineModule({ ...base, manifest: { id: 'x', version: '0.0.0', sdkVersion: '^0.1.0', name: '', description: 'x', permissions: [] } }))
        .toThrow(TypeError)
    })

    it('throws when description is missing', () => {
      expect(() => defineModule({ ...base, manifest: { id: 'x', version: '0.0.0', sdkVersion: '^0.1.0', name: 'X', description: '', permissions: [] } }))
        .toThrow(TypeError)
    })

    it('throws when permissions is not an array', () => {
      expect(() => defineModule({ ...base, manifest: { id: 'x', version: '0.0.0', sdkVersion: '^0.1.0', name: 'X', description: 'x', permissions: null as unknown as [] } }))
        .toThrow(TypeError)
    })
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
            sdkVersion: '^0.1.0',
            name: 'l',
            description: 'lifecycle test',
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

    it('optional fields are undefined when not set', () => {
      const minimal = defineModule({
        manifest: {
          id: 'minimal',
          version: '0.0.1',
          sdkVersion: '^0.1.0',
          name: 'Minimal',
          description: 'minimal module for testing optional fields',
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
          sdkVersion: '^0.1.0',
          name: 'Publish',
          description: 'publishes markdown to a blog',
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

  // ── Agent24 manifest extension fields ───────────────────────────────────

  describe('Agent24 manifest fields — happy path', () => {
    const baseOps = {
      async load() {},
      async unload() {},
      async invoke() { return { ok: true as const, data: null } },
    }
    const baseManifest = {
      id: 'agent24-module',
      version: '1.0.0',
      sdkVersion: '^0.1.0',
      name: 'Agent24 Module',
      description: 'Module exercising Agent24 runtime fields',
      permissions: [] as [],
    }

    it('accepts type: ui', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, type: 'ui' as ModuleType },
      })
      expect(mod.manifest.type).toBe('ui')
    })

    it('accepts type: headless', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, type: 'headless' as ModuleType },
      })
      expect(mod.manifest.type).toBe('headless')
    })

    it('accepts type: hybrid', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, type: 'hybrid' as ModuleType },
      })
      expect(mod.manifest.type).toBe('hybrid')
    })

    it('accepts navItem with icon, label, route', () => {
      const nav: ModuleNavItem = { icon: 'Pen', label: 'Publish', route: '/publish' }
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, navItem: nav },
      })
      expect(mod.manifest.navItem).toEqual(nav)
    })

    it('accepts models as a string array', () => {
      const models = ['claude-3-5-sonnet', 'gpt-4o']
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, models },
      })
      expect(mod.manifest.models).toEqual(models)
    })

    it('accepts empty models array', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, models: [] },
      })
      expect(mod.manifest.models).toEqual([])
    })

    it('accepts container config with all fields', () => {
      const container: ContainerConfig = {
        image: 'ghcr.io/example/my-module:1.0.0',
        port: 8080,
        startCmd: ['node', 'server.js'],
        healthPath: '/health',
        memoryMib: 256,
      }
      const mod = defineModule({
        ...baseOps,
        manifest: { ...baseManifest, container },
      })
      expect(mod.manifest.container).toEqual(container)
    })

    it('accepts container config with required fields only', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: {
          ...baseManifest,
          container: { image: 'my-image:latest', port: 3000 },
        },
      })
      expect(mod.manifest.container?.image).toBe('my-image:latest')
      expect(mod.manifest.container?.port).toBe(3000)
      expect(mod.manifest.container?.startCmd).toBeUndefined()
    })

    it('accepts all Agent24 fields together', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: {
          ...baseManifest,
          type: 'ui' as ModuleType,
          navItem: { icon: 'Star', label: 'My Module', route: '/my' },
          models: ['claude-3-haiku'],
          container: { image: 'example:v1', port: 9000 },
        },
      })
      expect(mod.manifest.type).toBe('ui')
      expect(mod.manifest.navItem?.route).toBe('/my')
      expect(mod.manifest.models).toEqual(['claude-3-haiku'])
      expect(mod.manifest.container?.port).toBe(9000)
    })

    it('new Agent24 fields are undefined when not set (backward compatible)', () => {
      const mod = defineModule({
        ...baseOps,
        manifest: baseManifest,
      })
      expect(mod.manifest.type).toBeUndefined()
      expect(mod.manifest.navItem).toBeUndefined()
      expect(mod.manifest.models).toBeUndefined()
      expect(mod.manifest.container).toBeUndefined()
    })
  })

  describe('Agent24 manifest fields — defineModule validation errors', () => {
    const baseOps = {
      async load() {},
      async unload() {},
      async invoke() { return { ok: true as const, data: null } },
    }
    const baseManifest = {
      id: 'x',
      version: '0.0.0',
      sdkVersion: '^0.1.0',
      name: 'X',
      description: 'x',
      permissions: [] as [],
    }

    it('throws TypeError for invalid type value', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            type: 'floating-window' as ModuleType,
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for empty string type value', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            type: '' as ModuleType,
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for container.image empty string', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            container: { image: '', port: 8080 },
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for container.port zero', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            container: { image: 'valid:latest', port: 0 },
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for container.port 65536 (out of range)', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            container: { image: 'valid:latest', port: 65536 },
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for container.port negative', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            container: { image: 'valid:latest', port: -1 },
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for container.port non-integer float', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            container: { image: 'valid:latest', port: 8080.5 },
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for models containing non-string element', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            models: ['valid-model', 42] as unknown as string[],
          },
        }),
      ).toThrow(TypeError)
    })

    it('throws TypeError for models being a non-array value', () => {
      expect(() =>
        defineModule({
          ...baseOps,
          manifest: {
            ...baseManifest,
            models: 'single-model-not-array' as unknown as string[],
          },
        }),
      ).toThrow(TypeError)
    })
  })
})
