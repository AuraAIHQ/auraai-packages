import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ModuleContext, MemoryHandle } from '@auraaihq/sdk'
import publishBlogModule from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(): MemoryHandle {
  const store = new Map<string, unknown>()
  return {
    get<T = unknown>(key: string): T | null {
      return (store.has(key) ? store.get(key) : null) as T | null
    },
    set(key: string, value: unknown): void {
      store.set(key, value)
    },
    delete(key: string): void {
      store.delete(key)
    },
    has(key: string): boolean {
      return store.has(key)
    },
    list(prefix?: string): string[] {
      const keys = [...store.keys()]
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys
    },
    namespace(_ns: string): MemoryHandle {
      throw new Error('namespace not needed in tests')
    },
  }
}

function makeCtx(memory?: MemoryHandle): ModuleContext {
  return {
    manifest: publishBlogModule.manifest,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    memory,
  }
}

// ---------------------------------------------------------------------------
// 1. Module shape / manifest
// ---------------------------------------------------------------------------

describe('publishBlogModule — manifest', () => {
  it('is exported via defineModule (has manifest + load + unload + invoke)', () => {
    expect(publishBlogModule).toBeDefined()
    expect(typeof publishBlogModule.load).toBe('function')
    expect(typeof publishBlogModule.unload).toBe('function')
    expect(typeof publishBlogModule.invoke).toBe('function')
  })

  it('manifest.id is "publish-blog"', () => {
    expect(publishBlogModule.manifest.id).toBe('publish-blog')
  })

  it('manifest.version is "0.1.0"', () => {
    expect(publishBlogModule.manifest.version).toBe('0.1.0')
  })

  it('manifest.intents covers all three intent kinds', () => {
    expect(publishBlogModule.manifest.intents).toEqual(
      expect.arrayContaining(['publish', 'preview', 'last-url']),
    )
    expect(publishBlogModule.manifest.intents).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 2. preview intent
// ---------------------------------------------------------------------------

describe('publishBlogModule — preview', () => {
  it('returns HTML wrapping the markdown in <pre>', async () => {
    const ctx = makeCtx()
    const result = await publishBlogModule.invoke(
      { kind: 'preview', payload: { markdown: '# Hello\n\nworld' } },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveProperty('html')
    const { html } = result.data as { html: string }
    expect(html).toContain('<pre>')
    expect(html).toContain('# Hello')
    expect(html).toContain('world')
  })

  it('escapes HTML special characters in markdown', async () => {
    const ctx = makeCtx()
    const result = await publishBlogModule.invoke(
      { kind: 'preview', payload: { markdown: '<script>alert("xss")</script>' } },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { html } = result.data as { html: string }
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// 3. publish intent — invalid endpoint
// ---------------------------------------------------------------------------

describe('publishBlogModule — publish (invalid endpoint)', () => {
  it('returns invalid_endpoint error when endpoint does not start with https://', async () => {
    const ctx = makeCtx(makeMemory())
    const result = await publishBlogModule.invoke(
      {
        kind: 'publish',
        payload: {
          title: 'My Post',
          markdown: '# Hello',
          endpoint: 'http://blog.example.com/publish',
        },
      },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_endpoint')
  })

  it('returns invalid_endpoint error for plain-string endpoints', async () => {
    const ctx = makeCtx(makeMemory())
    const result = await publishBlogModule.invoke(
      {
        kind: 'publish',
        payload: {
          title: 'My Post',
          markdown: '# Hello',
          endpoint: 'ftp://example.com',
        },
      },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_endpoint')
  })
})

// ---------------------------------------------------------------------------
// 4. publish intent — success (mocked fetch)
// ---------------------------------------------------------------------------

describe('publishBlogModule — publish (success)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://blog.example.com/post-1' }),
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns ok=true with url from endpoint response', async () => {
    const memory = makeMemory()
    const ctx = makeCtx(memory)
    const result = await publishBlogModule.invoke(
      {
        kind: 'publish',
        payload: {
          title: 'My Post',
          markdown: '# Hello',
          endpoint: 'https://blog.example.com/publish',
        },
      },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { url: string }).url).toBe(
      'https://blog.example.com/post-1',
    )
  })

  it('stores published url in memory', async () => {
    const memory = makeMemory()
    const ctx = makeCtx(memory)
    await publishBlogModule.invoke(
      {
        kind: 'publish',
        payload: {
          title: 'My Post',
          markdown: '# Hello',
          endpoint: 'https://blog.example.com/publish',
        },
      },
      ctx,
    )
    expect(memory.get('last-published-url')).toBe(
      'https://blog.example.com/post-1',
    )
  })

  it('calls fetch with correct method, headers, and body', async () => {
    const memory = makeMemory()
    const ctx = makeCtx(memory)
    await publishBlogModule.invoke(
      {
        kind: 'publish',
        payload: {
          title: 'My Post',
          markdown: '# Hello',
          endpoint: 'https://blog.example.com/publish',
        },
      },
      ctx,
    )
    const mockFetch = vi.mocked(globalThis.fetch)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://blog.example.com/publish')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    const parsedBody = JSON.parse(init.body as string)
    expect(parsedBody).toEqual({ title: 'My Post', markdown: '# Hello' })
  })
})

// ---------------------------------------------------------------------------
// 5. last-url intent
// ---------------------------------------------------------------------------

describe('publishBlogModule — last-url', () => {
  it('returns null when memory has no stored url', async () => {
    const ctx = makeCtx(makeMemory())
    const result = await publishBlogModule.invoke(
      { kind: 'last-url', payload: {} },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { url: string | null }).url).toBeNull()
  })

  it('returns null when no memory handle provided', async () => {
    const ctx = makeCtx(undefined)
    const result = await publishBlogModule.invoke(
      { kind: 'last-url', payload: {} },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { url: string | null }).url).toBeNull()
  })

  it('returns stored url after a publish', async () => {
    const memory = makeMemory()
    memory.set('last-published-url', 'https://blog.example.com/my-post')
    const ctx = makeCtx(memory)
    const result = await publishBlogModule.invoke(
      { kind: 'last-url', payload: {} },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { url: string | null }).url).toBe(
      'https://blog.example.com/my-post',
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Unknown intent
// ---------------------------------------------------------------------------

describe('publishBlogModule — unknown intent', () => {
  it('returns unknown_intent error for unrecognised kind', async () => {
    const ctx = makeCtx()
    const result = await publishBlogModule.invoke(
      // Cast to bypass TypeScript's exhaustiveness — the kernel can do this
      { kind: 'does-not-exist' as 'publish', payload: {} as never },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unknown_intent')
    expect(result.error.message).toContain('does-not-exist')
  })
})

// ---------------------------------------------------------------------------
// 7. lifecycle hooks
// ---------------------------------------------------------------------------

describe('publishBlogModule — lifecycle', () => {
  it('load() resolves without error', async () => {
    const ctx = makeCtx(makeMemory())
    await expect(publishBlogModule.load(ctx)).resolves.toBeUndefined()
  })

  it('unload() resolves without error', async () => {
    await expect(publishBlogModule.unload()).resolves.toBeUndefined()
  })
})
