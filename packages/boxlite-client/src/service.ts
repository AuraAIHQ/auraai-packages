// Container service manager — wraps @boxlite-ai/boxlite SimpleBox.
// Manages long-running OCI service containers with port-forwarding and health checks.
// The native binding is loaded lazily so the package degrades gracefully when BoxLite
// is unavailable (e.g., non-Apple-Silicon hardware or missing native module).

import http from 'node:http'
import type { ContainerConfig } from '@auraaihq/sdk'

export type { ContainerConfig }

export interface StartResult {
  ok: boolean
  hostPort?: number
  error?: string
}

// Host port range: 18000–18999 (1000 slots).
// Ports are never recycled — the pool is sized to last the process lifetime.
const PORT_MIN = 18000
const PORT_MAX = 18999
let nextHostPort = PORT_MIN

// Overridable in tests via __resetForTest to avoid waiting 60s for health checks to fail.
let _healthTimeoutMs = 60_000

function allocatePort(): number {
  if (nextHostPort > PORT_MAX) throw new Error(`Service port pool exhausted (${PORT_MIN}-${PORT_MAX})`)
  return nextHostPort++
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SimpleBoxConstructor = new (opts: object) => any

let _SimpleBoxClass: SimpleBoxConstructor | null = null
let _serviceInitError: string | null = null
let _serviceInitialized = false

function ensureServiceInit(): void {
  if (_serviceInitialized) return
  _serviceInitialized = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@boxlite-ai/boxlite') as { SimpleBox: SimpleBoxConstructor }
    _SimpleBoxClass = mod.SimpleBox
  } catch (err) {
    _serviceInitError = err instanceof Error ? err.message : String(err)
  }
}

/** Returns true if the BoxLite native binding loaded successfully. */
export function isServiceAvailable(): boolean {
  ensureServiceInit()
  return _SimpleBoxClass !== null
}

/** Returns the init error message if the native binding failed to load, null otherwise. */
export function getServiceError(): string | null {
  ensureServiceInit()
  return _serviceInitError
}

interface ServiceEntry {
  hostPort: number
  config: ContainerConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  box: any
}

// Registry of running service boxes: moduleId → entry
const _registry = new Map<string, ServiceEntry>()
// In-flight start promises — prevents concurrent double-start for the same moduleId
const _starting = new Map<string, Promise<StartResult>>()
// Boxes created but not yet healthy — tracked so stopAll() can clean them up
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pending = new Map<string, any>()

function httpGet(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume() // drain body to free socket
      res.once('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(0))
    req.setTimeout(2000, () => { req.destroy(); resolve(0) })
  })
}

async function waitHealthy(hostPort: number, healthPath: string, timeoutMs = 60_000): Promise<boolean> {
  const url = `http://127.0.0.1:${hostPort}${healthPath}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const code = await httpGet(url)
    if (code >= 200 && code < 300) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

async function doStartService(moduleId: string, cfg: ContainerConfig): Promise<StartResult> {
  ensureServiceInit()
  if (!_SimpleBoxClass) return { ok: false, error: `BoxLite unavailable: ${_serviceInitError}` }
  if (_registry.has(moduleId)) return { ok: true, hostPort: _registry.get(moduleId)!.hostPort }

  let hostPort: number
  try {
    hostPort = allocatePort()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const healthPath = cfg.healthPath ?? '/health'
  const boxOpts = {
    image: cfg.image,
    memoryMib: cfg.memoryMib ?? 512,
    ports: [{ hostPort, guestPort: cfg.port }],
    autoRemove: true,
    name: `auraaihq-svc-${moduleId}`,
    reuseExisting: false,
  }

  let box: unknown
  try {
    box = new _SimpleBoxClass(boxOpts)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  _pending.set(moduleId, box)

  if (cfg.startCmd && cfg.startCmd.length > 0) {
    const [cmd, ...args] = cfg.startCmd
    try {
      // Shell-safe quoting: each arg is POSIX single-quote-escaped to prevent injection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (box as any).exec('sh', ['-c', `nohup ${[cmd, ...args].map((a) => {
        return "'" + String(a).replace(/'/g, "'\\''") + "'"
      }).join(' ')} > /tmp/svc.log 2>&1 &`])
    } catch (err) {
      _pending.delete(moduleId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (box as any).stop().catch(() => { /* best-effort */ })
      return { ok: false, error: `Failed to start service: ${err instanceof Error ? err.message : err}` }
    }
  }

  const healthy = await waitHealthy(hostPort, healthPath, _healthTimeoutMs)
  _pending.delete(moduleId)
  if (!healthy) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (box as any).stop().catch(() => { /* best-effort */ })
    return { ok: false, error: `Service did not become healthy within 60s (checked ${healthPath})` }
  }

  _registry.set(moduleId, { hostPort, config: cfg, box })
  return { ok: true, hostPort }
}

/** Start a service container for a module. Concurrent calls for the same moduleId share one promise. */
export function startService(moduleId: string, cfg: ContainerConfig): Promise<StartResult> {
  if (_registry.has(moduleId)) return Promise.resolve({ ok: true, hostPort: _registry.get(moduleId)!.hostPort })
  const existing = _starting.get(moduleId)
  if (existing) return existing
  const p = doStartService(moduleId, cfg).finally(() => _starting.delete(moduleId))
  _starting.set(moduleId, p)
  return p
}

/** Stop the service container for a module. No-op if not running. */
export async function stopService(moduleId: string): Promise<void> {
  const entry = _registry.get(moduleId)
  if (!entry) return
  _registry.delete(moduleId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (entry.box as any).stop().catch(() => { /* best-effort */ })
}

/** Stop all running and in-flight (pending health check) containers. */
export async function stopAll(): Promise<void> {
  const pendingStops = [..._pending.entries()].map(async ([id, box]) => {
    _pending.delete(id)
    await (box as { stop(): Promise<void> }).stop().catch(() => { /* best-effort */ })
  })
  await Promise.all([[..._registry.keys()].map(stopService), ...pendingStops].flat())
}

/** Returns the host port a module's container is forwarded to, or null if not running. */
export function getHostPort(moduleId: string): number | null {
  return _registry.get(moduleId)?.hostPort ?? null
}

/** Returns true if a container for this moduleId is running or currently starting. */
export function isRegistered(moduleId: string): boolean {
  return _registry.has(moduleId) || _starting.has(moduleId)
}

/**
 * Proxy an HTTP request to a running service container.
 * Returns { status, headers, rawBody } — caller forwards headers and body as-is.
 * Strips RFC 7230 hop-by-hop headers from container response.
 */
export async function proxyToService(
  moduleId: string,
  method: 'GET' | 'POST',
  subPath: string,
  query: string,
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string>; rawBody: Buffer }> {
  const entry = _registry.get(moduleId)
  if (!entry) throw Object.assign(new Error(`Service ${moduleId} not running`), { statusCode: 503 })

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: entry.hostPort,
      path: subPath + query,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30_000,
    }
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const HOP_BY_HOP = new Set([
          'transfer-encoding', 'connection', 'keep-alive',
          'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
        ])
        const fwd: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') fwd[k] = v
        }
        resolve({ status: res.statusCode ?? 200, headers: fwd, rawBody: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Proxy timeout to ${moduleId}:${subPath}`)) })
    if (payload) req.write(payload)
    req.end()
  })
}

// Test-only helpers (__ prefix = internal, not part of the public API).

/** Reset all state and optionally inject a fake SimpleBox constructor. Pass healthTimeoutMs to speed up health-check failures in tests. */
export function __resetForTest(fakeSimpleBox?: SimpleBoxConstructor, healthTimeoutMs = 60_000): void {
  _SimpleBoxClass = fakeSimpleBox ?? null
  _serviceInitError = fakeSimpleBox ? null : 'injected for test'
  _serviceInitialized = true
  _registry.clear()
  _starting.clear()
  _pending.clear()
  nextHostPort = PORT_MIN
  _healthTimeoutMs = healthTimeoutMs
}

/** Inject a pre-started registry entry so tests can exercise proxy / registry paths without a real container. */
export function __injectEntryForTest(
  moduleId: string,
  hostPort: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  box: any = { stop: async () => {} },
): void {
  _registry.set(moduleId, { hostPort, config: { image: 'test', port: hostPort }, box })
}
