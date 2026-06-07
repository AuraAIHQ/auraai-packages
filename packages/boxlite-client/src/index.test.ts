import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as host from './host.js'
import * as svc from './service.js'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

// ---------------------------------------------------------------------------
// Host — no native binding (default in CI / test environment)
// ---------------------------------------------------------------------------

describe('@auraaihq/boxlite-client — host (no native binding)', () => {
  beforeEach(() => host.__resetHostForTest())
  afterEach(() => host.__resetHostForTest())

  it('isBoxliteAvailable() returns false', () => {
    expect(host.isBoxliteAvailable()).toBe(false)
  })

  it('getBoxliteError() returns a non-empty string', () => {
    const err = host.getBoxliteError()
    expect(typeof err).toBe('string')
    expect(err!.length).toBeGreaterThan(0)
  })

  it('runPython() returns ok:false with BoxLite unavailable message', async () => {
    const result = await host.runPython('print("hello")')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('BoxLite unavailable')
  })
})

// ---------------------------------------------------------------------------
// Host — fake CodeBox injected
// ---------------------------------------------------------------------------

describe('@auraaihq/boxlite-client — host (fake CodeBox)', () => {
  afterEach(() => host.__resetHostForTest())

  it('isBoxliteAvailable() returns true', () => {
    host.__resetHostForTest(class { async run(): Promise<string> { return '' } async stop() {} })
    expect(host.isBoxliteAvailable()).toBe(true)
  })

  it('getBoxliteError() returns null', () => {
    host.__resetHostForTest(class { async run(): Promise<string> { return '' } async stop() {} })
    expect(host.getBoxliteError()).toBeNull()
  })

  it('runPython() returns ok:true with output', async () => {
    host.__resetHostForTest(class {
      async run(_code: string) { return 'hello world\n' }
      async stop() {}
    })
    const result = await host.runPython('print("hello world")')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).toBe('hello world\n')
  })

  it('runPython() returns ok:false when box.run() throws', async () => {
    host.__resetHostForTest(class {
      async run(): Promise<string> { throw new Error('execution failed') }
      async stop() {}
    })
    const result = await host.runPython('raise Exception()')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('execution failed')
  })

  it('runPython() calls stop() even when run() throws', async () => {
    let stopped = false
    host.__resetHostForTest(class {
      async run(): Promise<string> { throw new Error('boom') }
      async stop() { stopped = true }
    })
    await host.runPython('x')
    expect(stopped).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Service — no native binding
// ---------------------------------------------------------------------------

describe('@auraaihq/boxlite-client — service (no native binding)', () => {
  beforeEach(() => svc.__resetForTest())
  afterEach(() => svc.__resetForTest())

  it('isServiceAvailable() returns false', () => {
    expect(svc.isServiceAvailable()).toBe(false)
  })

  it('getServiceError() returns a non-empty string', () => {
    const err = svc.getServiceError()
    expect(typeof err).toBe('string')
    expect(err!.length).toBeGreaterThan(0)
  })

  it('startService() returns ok:false', async () => {
    const result = await svc.startService('mod-a', { image: 'img', port: 8080 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('BoxLite unavailable')
  })

  it('getHostPort() returns null for unknown moduleId', () => {
    expect(svc.getHostPort('unknown')).toBeNull()
  })

  it('isRegistered() returns false for unknown moduleId', () => {
    expect(svc.isRegistered('unknown')).toBe(false)
  })

  it('stopService() is a no-op for unknown moduleId', async () => {
    await expect(svc.stopService('unknown')).resolves.toBeUndefined()
  })

  it('stopAll() resolves when nothing is running', async () => {
    await expect(svc.stopAll()).resolves.toBeUndefined()
  })

  it('proxyToService() throws 503 for unknown moduleId', async () => {
    const err = await svc.proxyToService('not-running', 'GET', '/path', '').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { statusCode?: number }).statusCode).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// Service — fake SimpleBox (concurrent start dedup)
// ---------------------------------------------------------------------------

describe('@auraaihq/boxlite-client — service (fake SimpleBox)', () => {
  afterEach(() => svc.__resetForTest())

  it('concurrent startService() calls for same id share one promise', async () => {
    let constructed = 0
    const FakeBox = class {
      constructor(_opts: object) { constructed++ }
      async exec() {}
      async stop() {}
    }
    // healthTimeoutMs: 200 so the health check fails fast (no real server at port 18000)
    svc.__resetForTest(FakeBox as never, 200)

    const [r1, r2] = await Promise.all([
      svc.startService('mod-concurrent', { image: 'img', port: 8080 }),
      svc.startService('mod-concurrent', { image: 'img', port: 8080 }),
    ])
    // Both fail (no real health endpoint) but only one box was constructed
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(constructed).toBe(1)
  }, 3000)

  it('startService() with startCmd fails gracefully when exec() throws', async () => {
    const FakeBox = class {
      constructor(_opts: object) {}
      async exec() { throw new Error('exec failed') }
      async stop() {}
    }
    svc.__resetForTest(FakeBox as never, 200)

    const result = await svc.startService('mod-cmd', {
      image: 'img',
      port: 8080,
      startCmd: ['my-server', '--port', '8080'],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Failed to start service')
  })

  it('stopService() calls box.stop()', async () => {
    let stopped = false
    svc.__injectEntryForTest('mod-stop', 18001, { stop: async () => { stopped = true } })
    await svc.stopService('mod-stop')
    expect(stopped).toBe(true)
    expect(svc.isRegistered('mod-stop')).toBe(false)
  })

  it('stopAll() stops running containers', async () => {
    const stops: string[] = []
    svc.__injectEntryForTest('mod-1', 18010, { stop: async () => { stops.push('mod-1') } })
    svc.__injectEntryForTest('mod-2', 18011, { stop: async () => { stops.push('mod-2') } })
    await svc.stopAll()
    expect(stops).toContain('mod-1')
    expect(stops).toContain('mod-2')
    expect(svc.isRegistered('mod-1')).toBe(false)
    expect(svc.isRegistered('mod-2')).toBe(false)
  })

  it('isRegistered() returns true for injected entry', () => {
    svc.__injectEntryForTest('mod-present', 18020)
    expect(svc.isRegistered('mod-present')).toBe(true)
  })

  it('getHostPort() returns the injected port', () => {
    svc.__injectEntryForTest('mod-port', 18030)
    expect(svc.getHostPort('mod-port')).toBe(18030)
  })
})

// ---------------------------------------------------------------------------
// Service — proxyToService against a real local HTTP server
// ---------------------------------------------------------------------------

describe('@auraaihq/boxlite-client — service (proxyToService)', () => {
  let server: http.Server
  let port: number

  beforeEach(async () => {
    const result = await makeTestServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'yes' })
        res.end(JSON.stringify({ method: req.method, path: req.url, body: chunks.join('') }))
      })
    })
    server = result.server
    port = result.port
    svc.__resetForTest()
    svc.__injectEntryForTest('proxy-mod', port)
  })

  afterEach(() => {
    svc.__resetForTest()
    server.close()
  })

  it('GET request proxied — returns 200 with response body', async () => {
    const result = await svc.proxyToService('proxy-mod', 'GET', '/ping', '')
    expect(result.status).toBe(200)
    const parsed = JSON.parse(result.rawBody.toString())
    expect(parsed.method).toBe('GET')
    expect(parsed.path).toBe('/ping')
  })

  it('POST request proxied — body forwarded correctly', async () => {
    const result = await svc.proxyToService('proxy-mod', 'POST', '/data', '', { key: 'value' })
    expect(result.status).toBe(200)
    const parsed = JSON.parse(result.rawBody.toString())
    expect(parsed.method).toBe('POST')
    expect(JSON.parse(parsed.body)).toEqual({ key: 'value' })
  })

  it('custom headers forwarded, hop-by-hop headers stripped', async () => {
    const result = await svc.proxyToService('proxy-mod', 'GET', '/headers', '')
    expect(result.headers['x-custom']).toBe('yes')
    expect(result.headers['transfer-encoding']).toBeUndefined()
    expect(result.headers['connection']).toBeUndefined()
  })

  it('query string appended to path', async () => {
    const result = await svc.proxyToService('proxy-mod', 'GET', '/search', '?q=test')
    const parsed = JSON.parse(result.rawBody.toString())
    expect(parsed.path).toBe('/search?q=test')
  })
})
