// publish-twitter: thin wrapper around the CBots sidecar HTTP API.
//
// CBots (cbots/) is a Python/Tweepy service that handles Twitter auth
// and API key management. This module translates SDK intents into calls
// to the CBots /api/send_tweet endpoint.
//
// Prerequisites: CBots must be running locally (default: http://localhost:8872).
// See cbots/README.md for setup and Twitter API key configuration.

import { defineModule, type Intent, type ModuleContext, type Result } from '@auraaihq/sdk'

// ---------------------------------------------------------------------------
// Intent union
// ---------------------------------------------------------------------------

export type PublishTwitterIntent =
  | Intent<'tweet', {
      message: string
      /** ISO 8601 datetime for scheduled delivery, e.g. "2026-05-10T09:00:00". */
      scheduledTime?: string
      /** Public image URL to attach to the tweet. */
      imageUrl?: string
      /** Base URL of the running CBots service. Default: http://localhost:8872 */
      cbotsUrl?: string
    }>
  | Intent<'last-tweet-url', Record<string, never> & { cbotsUrl?: string }>

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface TweetData {
  /** URL of the published tweet, if returned by CBots. */
  url?: string
  status: string
}

export interface LastTweetUrlData {
  url: string | null
}

// ---------------------------------------------------------------------------
// Default CBots endpoint
// ---------------------------------------------------------------------------

const DEFAULT_CBOTS_URL = 'http://localhost:8872'

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleTweet(
  payload: Extract<PublishTwitterIntent, { kind: 'tweet' }>['payload'],
  ctx: ModuleContext,
): Promise<Result<TweetData>> {
  const base = (payload.cbotsUrl ?? DEFAULT_CBOTS_URL).replace(/\/$/, '')

  let baseUrl: URL
  try {
    baseUrl = new URL(base)
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      return {
        ok: false,
        error: { code: 'invalid_cbots_url', message: 'cbotsUrl must use http:// or https://' },
      }
    }
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_cbots_url', message: 'cbotsUrl is not a valid URL' },
    }
  }

  const body: Record<string, unknown> = { message: payload.message }
  if (payload.scheduledTime) body['scheduled_time'] = payload.scheduledTime
  if (payload.imageUrl) body['image_url'] = payload.imageUrl

  let response: Response
  try {
    response = await fetch(`${baseUrl.origin}/api/send_tweet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'network_error',
        message: `Cannot reach CBots at ${baseUrl.origin} — is it running?`,
        cause,
      },
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'cbots_error', message: `CBots returned HTTP ${response.status}` },
    }
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    return {
      ok: false,
      error: { code: 'invalid_response', message: 'CBots returned non-JSON response', cause },
    }
  }

  const rec = data as Record<string, unknown>
  const url = typeof rec?.url === 'string' ? rec.url : undefined
  const status = typeof rec?.status === 'string' ? rec.status : 'ok'
  ctx.log.info('Tweet sent', url ?? '(no url)')
  return { ok: true, data: { url, status } }
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

const publishTwitterModule = defineModule<PublishTwitterIntent>({
  manifest: {
    id: 'publish-twitter',
    version: '0.1.0',
    sdkVersion: '^0.1.0',
    name: 'Twitter Publisher',
    description: 'Broadcast tweets via CBots sidecar (Tweepy backend)',
    permissions: ['net'],
    intents: ['tweet', 'last-tweet-url'],
    lifecycle: 'on-demand',
  },

  async load(ctx: ModuleContext): Promise<void> {
    ctx.log.info('publish-twitter module loaded')
  },

  async unload(): Promise<void> {},

  async invoke(intent: PublishTwitterIntent, ctx: ModuleContext): Promise<Result> {
    switch (intent.kind) {
      case 'tweet':
        return handleTweet(intent.payload, ctx)
      case 'last-tweet-url':
        // CBots doesn't expose a last-tweet-url endpoint yet; reserved for M2.
        return { ok: true, data: { url: null } }
      default: {
        const exhausted = intent as Intent
        return {
          ok: false,
          error: { code: 'unknown_intent', message: `Unknown intent kind: "${exhausted.kind}"` },
        }
      }
    }
  },
})

export default publishTwitterModule
