import { defineModule, type Intent, type ModuleContext, type Result } from '@auraaihq/sdk'

// ---------------------------------------------------------------------------
// Intent union — all intents this module handles
// ---------------------------------------------------------------------------

export type PublishBlogIntent =
  | Intent<'publish', { title: string; markdown: string; endpoint: string }>
  | Intent<'preview', { markdown: string }>
  | Intent<'last-url', Record<string, never>>

// ---------------------------------------------------------------------------
// Result data shapes (exported for consumers / tests)
// ---------------------------------------------------------------------------

export interface PublishData {
  url: string
}

export interface PreviewData {
  html: string
}

export interface LastUrlData {
  url: string | null
}

// ---------------------------------------------------------------------------
// Memory key
// ---------------------------------------------------------------------------

const LAST_URL_KEY = 'last-published-url'

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

async function handlePublish(
  payload: { title: string; markdown: string; endpoint: string },
  ctx: ModuleContext,
): Promise<Result<PublishData>> {
  if (!payload.endpoint.startsWith('https://')) {
    return {
      ok: false,
      error: {
        code: 'invalid_endpoint',
        message: 'endpoint must start with https://',
      },
    }
  }

  let response: Response
  try {
    response = await fetch(payload.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: payload.title, markdown: payload.markdown }),
    })
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'network_error',
        message: `Failed to reach endpoint: ${String(cause)}`,
        cause,
      },
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'http_error',
        message: `Endpoint returned HTTP ${response.status}`,
      },
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message: 'Endpoint returned non-JSON response',
        cause,
      },
    }
  }

  const url = (body as Record<string, unknown>)?.url
  if (typeof url !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message: 'Endpoint response missing string field "url"',
      },
    }
  }

  ctx.memory?.set(LAST_URL_KEY, url)
  ctx.log.info('Published blog post', url)

  return { ok: true, data: { url } }
}

function handlePreview(payload: { markdown: string }): Result<PreviewData> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Preview</title></head>
<body><pre>${escapeHtml(payload.markdown)}</pre></body>
</html>`
  return { ok: true, data: { html } }
}

function handleLastUrl(ctx: ModuleContext): Result<LastUrlData> {
  const url = ctx.memory?.get<string>(LAST_URL_KEY) ?? null
  return { ok: true, data: { url } }
}

// Minimal HTML escape — only what's needed inside <pre>
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

const publishBlogModule = defineModule<PublishBlogIntent>({
  manifest: {
    id: 'publish-blog',
    version: '0.1.0',
    sdkVersion: '^0.1.0',
    name: 'Blog Publisher',
    description: 'Publish markdown content as a blog post via HTTP endpoint',
    permissions: ['memory:read', 'memory:write', 'net'],
    intents: ['publish', 'preview', 'last-url'],
    lifecycle: 'on-demand',
  },

  async load(ctx: ModuleContext): Promise<void> {
    ctx.log.info('publish-blog module loaded')
  },

  async unload(): Promise<void> {
    // No resources to release in this module
  },

  async invoke(intent: PublishBlogIntent, ctx: ModuleContext): Promise<Result> {
    switch (intent.kind) {
      case 'publish':
        return handlePublish(intent.payload, ctx)

      case 'preview':
        return handlePreview(intent.payload)

      case 'last-url':
        return handleLastUrl(ctx)

      default: {
        // TypeScript exhaustiveness guard — the cast is needed because the
        // kernel may route unknown intent kinds to this module at runtime.
        const exhausted = intent as Intent
        return {
          ok: false,
          error: {
            code: 'unknown_intent',
            message: `Unknown intent kind: "${exhausted.kind}"`,
          },
        }
      }
    }
  },
})

export default publishBlogModule
