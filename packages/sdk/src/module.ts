// Module interface v0.1 — minimal, unstable. See ADR-010.
//
// A `Module` is a unit of capability that the @auraaihq/core kernel
// can load, query, invoke, and unload. Modules declare a manifest
// describing their identity and required permissions, then implement
// lifecycle hooks plus an `invoke` entry point.

/**
 * Capability permissions a module may declare. The kernel grants
 * matching context access at load time. Unknown permissions are
 * rejected by the loader.
 */
export type Permission =
  | 'fs:read'
  | 'fs:write'
  | 'net'
  | 'ai'
  | 'memory:read'
  | 'memory:write'
  | `module:invoke:${string}`

/**
 * Static metadata describing the module. Loaded before `load()` so the
 * kernel can verify version/dependencies/permissions and request user
 * authorization for sensitive scopes.
 */
export interface ModuleManifest {
  /** Globally unique ID, kebab-case (e.g. "publish-blog"). */
  id: string
  /** Semver version of this module. */
  version: string
  /** Human-readable name shown in the UI. */
  name: string
  /** One-sentence description. */
  description: string
  /** Permissions this module needs to function. */
  permissions: readonly Permission[]
  /**
   * IDs of other modules this module depends on. The kernel guarantees
   * dependencies load first. Cycles are rejected at registration.
   */
  dependencies?: readonly string[]
}

/** Minimal logger surface; real kernel logger arrives in M2. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * AI invocation handle. M1 placeholder — concrete shape decided in M2
 * once @auraaihq/ai-bridge lands.
 */
export interface AIHandle {
  /**
   * Generate a completion. Provider routing is the kernel's concern.
   * Returns the assistant's text. M2 will add streaming + tool use.
   */
  complete(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>
}

/**
 * Memory handle scoped to this module. The kernel passes a namespace-
 * isolated child of the global memory store so modules cannot collide.
 */
export interface MemoryHandle {
  get<T = unknown>(key: string): T | null
  set(key: string, value: unknown): void
  delete(key: string): void
  list(prefix?: string): string[]
}

/**
 * Runtime context provided to a module on `load()` and each `invoke()`.
 * The kernel constructs this based on the module's declared permissions.
 */
export interface ModuleContext {
  /** Module's own manifest (echoed for convenience). */
  readonly manifest: ModuleManifest
  /** Logger pre-tagged with the module ID. */
  readonly log: Logger
  /** AI handle, present only if `permissions` includes `'ai'`. */
  readonly ai?: AIHandle
  /** Memory handle, present if `memory:read` and/or `memory:write`. */
  readonly memory?: MemoryHandle
}

/**
 * An intent is the request a module receives via `invoke()`. The
 * `kind` is the routing key; payloads are typed per-module.
 */
export interface Intent<TPayload = unknown> {
  kind: string
  payload: TPayload
}

/**
 * Result of an `invoke()`. Either succeeds with `data`, or fails with
 * an error code + message. M2 may add streaming / partial results.
 */
export type Result<TData = unknown> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string; cause?: unknown } }

/**
 * The Module contract. Implementations are typically authored using
 * `defineModule({ manifest, ... })` for type inference.
 */
export interface Module {
  readonly manifest: ModuleManifest

  /**
   * Called once when the module is first loaded. Use to acquire
   * resources, register internal handlers, etc. The kernel passes a
   * fresh `ModuleContext` whose lifetime matches this module's.
   */
  load(ctx: ModuleContext): Promise<void>

  /**
   * Called once before the module is unloaded (uninstalled, app
   * shutting down, version upgrade). Release any open resources.
   */
  unload(): Promise<void>

  /**
   * Process a single intent. The kernel routes intents based on `kind`
   * and the manifest's declared capabilities. Modules MUST be
   * idempotent for retried intents that share the same logical
   * request id (the kernel will pass an `idempotencyKey` in M2+).
   *
   * Note: payload/data are intentionally `unknown` at the contract
   * level — modules narrow internally based on `intent.kind`, and
   * callers should validate the returned `data` shape per their needs.
   * Generic helpers for typed intents are planned for v0.2.
   */
  invoke(intent: Intent, ctx: ModuleContext): Promise<Result>
}

/**
 * Helper for authoring modules with full type inference. The shape
 * is the same as implementing `Module` directly, but the helper makes
 * the manifest discoverable as a literal type.
 *
 * @example
 * export default defineModule({
 *   manifest: {
 *     id: 'publish-blog',
 *     version: '0.1.0',
 *     name: 'Blog Publisher',
 *     description: 'Publish markdown to a blog',
 *     permissions: ['fs:read', 'net', 'ai'],
 *   },
 *   async load(ctx) { ctx.log.info('blog publisher ready') },
 *   async unload() {},
 *   async invoke(intent, ctx) {
 *     if (intent.kind === 'publish') return { ok: true, data: { url: '...' } }
 *     return { ok: false, error: { code: 'unknown_intent', message: intent.kind } }
 *   },
 * })
 */
export function defineModule(module: Module): Module {
  return module
}
