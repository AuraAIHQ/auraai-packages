import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import publishTwitterModule from './index'

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const ctx = { manifest: publishTwitterModule.manifest, log: noopLog }

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response)
}

describe('@auraaihq/publish-twitter', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('manifest is correct', () => {
    expect(publishTwitterModule.manifest.id).toBe('publish-twitter')
    expect(publishTwitterModule.manifest.sdkVersion).toBe('^0.1.0')
    expect(publishTwitterModule.manifest.intents).toContain('tweet')
  })

  it('load/unload succeed', async () => {
    await publishTwitterModule.load(ctx)
    await publishTwitterModule.unload()
  })

  describe('tweet intent', () => {
    it('returns ok with tweet url on success', async () => {
      vi.stubGlobal('fetch', mockFetch(200, { status: 'Tweet sent', url: 'https://x.com/user/status/123' }))
      const result = await publishTwitterModule.invoke(
        {
          kind: 'tweet',
          payload: { message: 'Hello Twitter!', cbotsUrl: 'http://localhost:8872' },
        },
        ctx,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.url).toBe('https://x.com/user/status/123')
        expect(result.data.status).toBe('Tweet sent')
      }
    })

    it('includes scheduled_time and image_url in request body', async () => {
      const fetchSpy = mockFetch(200, { status: 'ok' })
      vi.stubGlobal('fetch', fetchSpy)
      await publishTwitterModule.invoke(
        {
          kind: 'tweet',
          payload: {
            message: 'scheduled tweet',
            scheduledTime: '2026-06-01T09:00:00',
            imageUrl: 'https://example.com/img.png',
            cbotsUrl: 'http://localhost:8872',
          },
        },
        ctx,
      )
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.scheduled_time).toBe('2026-06-01T09:00:00')
      expect(body.image_url).toBe('https://example.com/img.png')
    })

    it('returns network_error when CBots is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const result = await publishTwitterModule.invoke(
        { kind: 'tweet', payload: { message: 'hi', cbotsUrl: 'http://localhost:8872' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('network_error')
    })

    it('returns cbots_error on HTTP 500', async () => {
      vi.stubGlobal('fetch', mockFetch(500, {}))
      const result = await publishTwitterModule.invoke(
        { kind: 'tweet', payload: { message: 'hi', cbotsUrl: 'http://localhost:8872' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('cbots_error')
    })

    it('returns invalid_cbots_url for non-http protocol', async () => {
      const result = await publishTwitterModule.invoke(
        { kind: 'tweet', payload: { message: 'hi', cbotsUrl: 'ftp://localhost' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid_cbots_url')
    })

    it('uses DEFAULT_CBOTS_URL when cbotsUrl omitted', async () => {
      const fetchSpy = mockFetch(200, { status: 'ok' })
      vi.stubGlobal('fetch', fetchSpy)
      await publishTwitterModule.invoke(
        { kind: 'tweet', payload: { message: 'hi' } },
        ctx,
      )
      expect((fetchSpy.mock.calls[0] as [string])[0]).toContain('localhost:8872')
    })
  })

  it('last-tweet-url returns null url (M2 placeholder)', async () => {
    const result = await publishTwitterModule.invoke(
      { kind: 'last-tweet-url', payload: {} },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.url).toBeNull()
  })

  it('returns unknown_intent for unrecognised kind', async () => {
    const result = await publishTwitterModule.invoke(
      { kind: 'unknown' as 'tweet', payload: {} as never },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_intent')
  })
})
