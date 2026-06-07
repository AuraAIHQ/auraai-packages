import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import publishTelegramModule, { type TelegramSendData } from './index'

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const ctx = { manifest: publishTelegramModule.manifest, log: noopLog }

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response)
}

describe('@auraaihq/publish-telegram', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('manifest is correct', () => {
    expect(publishTelegramModule.manifest.id).toBe('publish-telegram')
    expect(publishTelegramModule.manifest.sdkVersion).toBe('^0.1.0')
    expect(publishTelegramModule.manifest.intents).toContain('send')
  })

  it('load/unload succeed', async () => {
    await publishTelegramModule.load(ctx)
    await publishTelegramModule.unload()
  })

  describe('send intent', () => {
    it('returns ok on CBots 200 success', async () => {
      vi.stubGlobal('fetch', mockFetch(200, { status: 'Message sent' }))
      const result = await publishTelegramModule.invoke(
        {
          kind: 'send',
          payload: {
            channel: '@testchannel',
            message: 'Hello from tests',
            cbotsUrl: 'http://localhost:8872',
          },
        },
        ctx,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect((result.data as TelegramSendData).status).toBe('Message sent')
      }
    })

    it('includes topic_id and scheduled_time in request body', async () => {
      const fetchSpy = mockFetch(200, { status: 'ok' })
      vi.stubGlobal('fetch', fetchSpy)
      await publishTelegramModule.invoke(
        {
          kind: 'send',
          payload: {
            channel: 'MyGroup/123',
            message: 'scheduled',
            topicId: 456,
            scheduledTime: '2026-06-01T09:00:00',
            cbotsUrl: 'http://localhost:8872',
          },
        },
        ctx,
      )
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.topic_id).toBe(456)
      expect(body.scheduled_time).toBe('2026-06-01T09:00:00')
    })

    it('returns network_error when CBots is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const result = await publishTelegramModule.invoke(
        { kind: 'send', payload: { channel: '@ch', message: 'hi', cbotsUrl: 'http://localhost:8872' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('network_error')
    })

    it('returns cbots_error on HTTP 500', async () => {
      vi.stubGlobal('fetch', mockFetch(500, {}))
      const result = await publishTelegramModule.invoke(
        { kind: 'send', payload: { channel: '@ch', message: 'hi', cbotsUrl: 'http://localhost:8872' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('cbots_error')
    })

    it('returns invalid_cbots_url for malformed url', async () => {
      const result = await publishTelegramModule.invoke(
        { kind: 'send', payload: { channel: '@ch', message: 'hi', cbotsUrl: 'not-a-url' } },
        ctx,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid_cbots_url')
    })

    it('uses DEFAULT_CBOTS_URL when cbotsUrl omitted', async () => {
      const fetchSpy = mockFetch(200, { status: 'ok' })
      vi.stubGlobal('fetch', fetchSpy)
      await publishTelegramModule.invoke(
        { kind: 'send', payload: { channel: '@ch', message: 'hi' } },
        ctx,
      )
      expect((fetchSpy.mock.calls[0] as [string])[0]).toContain('localhost:8872')
    })
  })

  it('returns unknown_intent for unrecognised kind', async () => {
    const result = await publishTelegramModule.invoke(
      { kind: 'unknown-kind' as 'send', payload: {} as never },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_intent')
  })
})
