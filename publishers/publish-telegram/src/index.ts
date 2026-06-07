// publish-telegram: thin wrapper around the CBots sidecar HTTP API.
//
// CBots (cbots/) is a Python/Telethon service that handles Telegram auth
// and session management. This module translates SDK intents into calls
// to the CBots /api/send_message endpoint, so the kernel can broadcast
// to Telegram without bundling a Python runtime into the Electron app.
//
// Prerequisites: CBots must be running locally (default: http://localhost:8872).
// See cbots/README.md for setup. The cbotsUrl can be overridden per-intent
// for multi-instance or remote deployments.

import { defineModule, type Intent, type ModuleContext, type Result } from '@auraaihq/sdk'

// ---------------------------------------------------------------------------
// Intent union
// ---------------------------------------------------------------------------

/**
 * Send a message to a Telegram channel or group.
 *
 * channel formats (see CBots README):
 *   - "Account_Abstraction_Community/18472"  (group/topic)
 *   - "https://t.me/c/1807106448/33"         (private channel link)
 *   - "https://t.me/ETHPandaOrg/25"          (public channel link)
 *   - "@channelname"                          (channel username)
 */
export type PublishTelegramIntent =
  | Intent<'send', {
      message: string
      channel: string
      /** Telegram topic/thread id (for supergroups with topics). */
      topicId?: number
      /** ISO 8601 datetime for scheduled delivery, e.g. "2026-05-10T09:00:00". */
      scheduledTime?: string
      /** Public image URL to attach. */
      imageUrl?: string
      /** Base URL of the running CBots service. Default: http://localhost:8872 */
      cbotsUrl?: string
    }>

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface TelegramSendData {
  /** Confirmation message from CBots. */
  status: string
}

// ---------------------------------------------------------------------------
// Default CBots endpoint
// ---------------------------------------------------------------------------

const DEFAULT_CBOTS_URL = 'http://localhost:8872'

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleSend(
  payload: Extract<PublishTelegramIntent, { kind: 'send' }>['payload'],
  ctx: ModuleContext,
): Promise<Result<TelegramSendData>> {
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

  const body: Record<string, unknown> = {
    channel: payload.channel,
    message: payload.message,
  }
  if (payload.topicId !== undefined) body['topic_id'] = payload.topicId
  if (payload.scheduledTime) body['scheduled_time'] = payload.scheduledTime
  if (payload.imageUrl) body['image_url'] = payload.imageUrl

  let response: Response
  try {
    response = await fetch(`${baseUrl.origin}/api/send_message`, {
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

  const status = (data as Record<string, unknown>)?.status
  ctx.log.info('Telegram message sent', payload.channel, status)
  return { ok: true, data: { status: typeof status === 'string' ? status : 'ok' } }
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

const publishTelegramModule = defineModule<PublishTelegramIntent>({
  manifest: {
    id: 'publish-telegram',
    version: '0.1.0',
    sdkVersion: '^0.1.0',
    name: 'Telegram Publisher',
    description: 'Broadcast messages to Telegram channels/groups via CBots sidecar',
    permissions: ['net'],
    intents: ['send'],
    lifecycle: 'on-demand',
  },

  async load(ctx: ModuleContext): Promise<void> {
    ctx.log.info('publish-telegram module loaded')
  },

  async unload(): Promise<void> {},

  async invoke(intent: PublishTelegramIntent, ctx: ModuleContext): Promise<Result> {
    switch (intent.kind) {
      case 'send':
        return handleSend(intent.payload, ctx)
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

export default publishTelegramModule
