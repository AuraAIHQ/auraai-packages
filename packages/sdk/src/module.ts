// Module interface v0.1 — minimal, unstable. See ADR-010.
//
// A `Module` is a unit of capability that the @auraaihq/core kernel
// can load, query, invoke, and unload. Modules declare a manifest
// describing their identity, what they need (permissions/deps), and
// what they offer (intents), then implement lifecycle hooks plus an
// `invoke` entry point.

/**
 * Capability permissions a module may declare. The kernel grants
 * matching context access at load time. Unknown permissions are
 * rejected by the loader.
 *
 * `module:invoke:{id}` permits invoking a peer module by id. The
 * kernel validates that the id is non-empty and that the target
 * module exists; types here cannot enforce that — runtime check
 * is mandatory.
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
 * Module lifecycle hint. The kernel uses this to schedule the module:
 *
 * - `persistent`: load once at app start, keep loaded until shutdown.
 *   Use for tray-resident services, daemons, schedulers.
 * - `on-demand`: load when first intent arrives, keep loaded for an
 *   idle window (kernel-configured), then unload. Use for occasional
 *   handlers like content publishers.
 * - `ephemeral`: load → invoke once → unload immediately. Use for
 *   short-lived one-shot tasks where state retention is undesired.
 *
 * Default is `on-demand` if omitted.
 */
export type ModuleLifecycle = 'persistent' | 'on-demand' | 'ephemeral'

/** Allowed values for {@link ModuleManifest.type}. */
const VALID_MODULE_TYPES = ['ui', 'headless', 'hybrid'] as const

/**
 * Agent24 module rendering type. Describes how the module is presented
 * in the Agent24 UI.
 *
 * - `ui`: module has a dedicated UI panel.
 * - `headless`: background service with no visual component.
 * - `hybrid`: has both UI and headless modes.
 *
 * Optional in SDK context (required by Agent24 framework at runtime).
 */
export type ModuleType = 'ui' | 'headless' | 'hybrid'

/**
 * Navigation item for Agent24's sidebar. Used when `type` is `'ui'` or
 * `'hybrid'` so the kernel can register an icon + label + route.
 */
export interface ModuleNavItem {
  /** Icon identifier (e.g. a Lucide icon name or an emoji). */
  icon: string
  /** Human-readable label shown in the sidebar. */
  label: string
  /** Client-side route path (e.g. "/modules/publish-blog"). */
  route: string
}

/**
 * OCI container configuration for Agent24's BoxLite runtime (M4).
 * Describes how to pull and start the module's container process.
 *
 * Validated by `defineModule` when present:
 * - `image` must be a non-empty string
 * - `port` must be an integer in the range 1–65535
 */
export interface ContainerConfig {
  /** OCI image reference (e.g. "ghcr.io/example/my-module:1.0.0"). */
  image: string
  /** Port the container listens on. Must be 1–65535. */
  port: number
  /** Override the container entrypoint command. */
  startCmd?: string[]
  /** HTTP path the kernel polls to determine readiness (e.g. "/health"). */
  healthPath?: string
  /** Memory limit in mebibytes. Kernel enforces a hard cap when set. */
  memoryMib?: number
}

/**
 * Static metadata describing the module. Loaded before `load()` so
 * the kernel can verify version/dependencies/permissions and request
 * user authorization for sensitive scopes.
 *
 * Runtime validation by the kernel/loader (NOT enforced by these
 * types):
 * - `id` must be non-empty kebab-case ([a-z0-9]+(-[a-z0-9]+)*) and
 *   must NOT contain `:` (reserved as namespace separator)
 * - `version` must be valid semver
 * - `sdkVersion` must be valid semver range
 * - `permissions` of form `module:invoke:{id}` — `{id}` validated
 *   per the same rules as `id`
 * - `dependencies` ids must exist + must not form cycles
 */
export interface ModuleManifest {
  /** Globally unique ID, kebab-case (e.g. "publish-blog"). */
  id: string
  /** Semver version of this module (e.g. "1.2.3"). */
  version: string
  /**
   * Semver range of `@auraaihq/sdk` this module was built against.
   * The kernel rejects modules whose required range doesn't match
   * its own SDK version.
   *
   * Required from v0.1. Omitting is a compile error — always set this
   * (e.g. `"^0.1.0"`) so the kernel can enforce SDK compatibility.
   */
  sdkVersion: string
  /** Human-readable name shown in the UI. */
  name: string
  /** One-sentence description. */
  description: string
  /** Permissions this module needs to function. */
  permissions: readonly Permission[]
  /**
   * Intent `kind` strings this module handles. The kernel uses this
   * to build a routing table. Modules MUST handle exactly the kinds
   * declared here — declaring more is wasted; declaring fewer than
   * implemented means callers can't discover them.
   *
   * Kebab-case is recommended (e.g. ["publish", "schedule"]).
   * Optional for backwards compatibility — but a module that omits
   * this is invisible to intent routing and only callable via
   * direct `module:invoke` references.
   */
  intents?: readonly string[]
  /**
   * IDs of other modules this module depends on. The kernel guarantees
   * dependencies load first. Cycles are rejected at registration.
   */
  dependencies?: readonly string[]
  /** Module lifecycle hint (default: `on-demand`). */
  lifecycle?: ModuleLifecycle

  // ── Agent24 framework fields (optional — preserves backward compatibility
  //    with non-Agent24 SDK consumers) ──────────────────────────────────────

  /**
   * Agent24 rendering type. Required by Agent24 at runtime but optional
   * here so non-Agent24 consumers can use `ModuleManifest` without it.
   * `defineModule` validates against the allowed union when present.
   */
  type?: ModuleType
  /**
   * Sidebar navigation item. Relevant when `type` is `'ui'` or `'hybrid'`.
   * The Agent24 kernel uses this to register an icon + route in the nav.
   */
  navItem?: ModuleNavItem
  /**
   * LLM model identifiers this module requests access to (M3).
   * The kernel resolves these against available AI-bridge adapters.
   * Example: `["claude-3-5-sonnet", "gpt-4o"]`.
   */
  models?: string[]
  /**
   * BoxLite OCI container configuration (M4). When present, the Agent24
   * runtime pulls the image and starts a sidecar container for this module.
   */
  container?: ContainerConfig
}

/** Minimal logger surface; real kernel logger arrives in M2. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * AI completion result with telemetry. Returned by
 * `AIHandle.completeDetailed` when present.
 */
export interface AICompletionResult {
  /** Generated text. */
  text: string
  /**
   * Approximate token usage when known. Adapters that don't expose
   * this still set the field for cost tracking, even if values are 0.
   */
  usage?: { promptTokens: number; completionTokens: number }
  /** Adapter id that produced the result. */
  adapterId?: string
}

/**
 * Stable error codes that `AdapterError` (from `@auraaihq/idoris`) may
 * carry. Defined here so SDK consumers can reference them without a direct
 * `idoris` dependency; `idoris` MUST use these exact strings.
 */
export type AdapterErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'aborted'
  | 'unknown'

/**
 * Stable error codes that `BridgeError` (from `@auraaihq/idoris`) may
 * carry for routing-level failures. Defined here so SDK consumers can
 * reference them without a direct `idoris` dependency; `idoris`
 * MUST use these exact strings.
 */
export type BridgeErrorCode =
  | 'aggregate'
  | 'no_adapters'
  | 'unknown_adapter'
  | 'duplicate_adapter'
  | 'duplicate_in_order'
  | 'policy_error'
  | 'policy_invalid_return'
  | 'invalid_adapter_metadata'
  | 'unsupported_method'

/**
 * AI invocation handle. M1 contract — concrete behaviour provided by
 * @auraaihq/idoris. M2 will add streaming + tool use.
 */
export interface AIHandle {
  /**
   * Generate a completion. Provider routing is the kernel/bridge's
   * concern. Returns the assistant's text on success.
   *
   * On failure, throws either:
   * - `AdapterError` (from `@auraaihq/idoris`) with a `code` of
   *   type {@link AdapterErrorCode} — adapter-level failure that wasn't
   *   recoverable by trying another adapter.
   * - `BridgeError` (from `@auraaihq/idoris`) with a `code` of
   *   type {@link BridgeErrorCode} — routing-level failure (no adapters,
   *   all adapters failed, policy error, etc.).
   *
   * Implementations MUST preserve the original error in `cause` so
   * callers can drill in for debugging.
   */
  complete(
    prompt: string,
    options?: {
      /** Soft cap on output tokens. Adapters may clamp lower. */
      maxTokens?: number
      /** 0 = deterministic, 1 = creative. */
      temperature?: number
      /** Optional system prompt prepended to the request. */
      system?: string
      /** Cancel signal for in-flight requests. */
      signal?: AbortSignal
    },
  ): Promise<string>
  /**
   * Like `complete` but returns the full result (text + usage +
   * adapterId). Use for telemetry/cost tracking. Optional —
   * implementations may omit this for legacy / minimal adapters.
   */
  completeDetailed?(
    prompt: string,
    options?: {
      maxTokens?: number
      temperature?: number
      system?: string
      signal?: AbortSignal
    },
  ): Promise<AICompletionResult>
}

/**
 * Memory handle scoped to this module. The kernel passes a namespace-
 * isolated child of the global memory store so modules cannot collide.
 *
 * **Permission semantics**: the kernel injects a `MemoryHandle` only when
 * `manifest.permissions` includes `memory:read` or `memory:write` (or both).
 *
 * - Declaring `memory:read` alone gives read-only access. Calling `set()` or
 *   `delete()` on the handle **throws a runtime error** — enforced by the
 *   kernel at M1, not deferred to a future release.
 * - Declaring `memory:write` (with or without `memory:read`) gives full
 *   read/write access.
 * - The permission check is performed once at `load()` time; individual
 *   method calls are guarded by the resulting access level.
 */
export interface MemoryHandle {
  /** Read a value. Returns null when absent. */
  get<T = unknown>(key: string): T | null
  /** Write any JSON-serializable value. */
  set(key: string, value: unknown): void
  /** Remove a key. */
  delete(key: string): void
  /**
   * Check whether a key exists. Use to disambiguate "absent" from
   * "stored as null".
   */
  has(key: string): boolean
  /**
   * List keys directly in this namespace, optionally filtered by prefix.
   * Sub-namespace keys are excluded; use `namespace('child').list()`.
   * `cursor` is reserved for future pagination — pass `undefined` for now.
   */
  list(prefix?: string, cursor?: string): string[]
  /**
   * Derive a child handle scoped under the given sub-namespace. Use
   * this to isolate different logical domains within a single module
   * (e.g. `memory.namespace('cache')` vs `memory.namespace('settings')`).
   */
  namespace(child: string): MemoryHandle
}

/**
 * Runtime context provided to a module on `load()` and each `invoke()`.
 *
 * **Lifecycle**: the kernel passes the SAME `ModuleContext` instance
 * to `load()` and to every subsequent `invoke()` for the lifetime of
 * the loaded module. Modules MAY treat fields like `manifest` and
 * `log` as stable references; do NOT close over a captured `ctx.ai`
 * across `unload()`/`load()` cycles since the kernel may reconstruct
 * them.
 *
 * Per-call request data (e.g., user id, request id) should travel in
 * `Intent.payload`, not on `ctx`.
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
 * `kind` is the routing key; payloads are typed per-kind.
 *
 * Specify both `TKind` and `TPayload` to get full type narrowing in
 * `Module.invoke`:
 *
 * ```ts
 * type PublishBlogIntent =
 *   | Intent<'publish', { md: string; title: string }>
 *   | Intent<'preview', { md: string }>
 * ```
 */
export interface Intent<TKind extends string = string, TPayload = unknown> {
  kind: TKind
  payload: TPayload
}

/**
 * Result of an `invoke()`. Either succeeds with `data`, or fails with
 * an error code + message.
 *
 * `code` is intentionally `string` rather than a closed union: modules
 * define their own domain-specific codes. Recommended convention:
 * `unknown_intent`, `invalid_payload`, `permission_denied`,
 * `dependency_unavailable`, `internal_error`. The kernel may inject
 * its own routing-level errors with prefixed codes (e.g. `kernel:*`).
 */
export type Result<TData = unknown> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string; cause?: unknown } }

/**
 * The Module contract. Implementations are typically authored using
 * `defineModule(...)` for type inference.
 *
 * The generic `TIntent` lets a module narrow `invoke`'s `intent`
 * parameter to its declared intent union — the compiler will warn
 * if `manifest.intents` doesn't cover all the union's `kind` values.
 */
export interface Module<
  TIntent extends Intent<string, unknown> = Intent<string, unknown>,
> {
  readonly manifest: ModuleManifest

  /**
   * Called once when the module is first loaded. Use to acquire
   * resources, register internal handlers, etc. The kernel passes a
   * fresh `ModuleContext` whose lifetime matches this module's; the
   * SAME `ctx` reference will be passed to every subsequent `invoke()`.
   */
  load(ctx: ModuleContext): Promise<void>

  /**
   * Called once before the module is unloaded (uninstalled, app
   * shutting down, version upgrade, idle eviction). Release any open
   * resources.
   */
  unload(): Promise<void>

  /**
   * Process a single intent. The kernel routes intents based on `kind`
   * matching `manifest.intents` (when declared). Modules MUST be
   * idempotent for retried intents that share the same logical
   * request id (the kernel will pass an `idempotencyKey` in M2+).
   *
   * **Known limitation (M1)**: the return type is `Promise<Result>` i.e.
   * `Result<unknown>`. The kernel has no static knowledge of each module's
   * result shape — only the *calling* module does. Callers that need typed
   * data should narrow `result.ok` then type-assert, or define a shared
   * type contract imported by both sides. A typed intent-routing layer
   * (M2) will address this by coupling intent `kind` to result shapes.
   */
  invoke(intent: TIntent, ctx: ModuleContext): Promise<Result>
}

/**
 * Helper for authoring modules with type inference. The generic flows
 * through so manifest literal types are preserved and the `invoke`
 * `intent` parameter can be narrowed by the module's declared union.
 *
 * @example
 * type PublishIntent =
 *   | Intent<'publish', { md: string }>
 *   | Intent<'preview', { md: string }>
 *
 * export default defineModule<PublishIntent>({
 *   manifest: {
 *     id: 'publish-blog',
 *     version: '0.1.0',
 *     sdkVersion: '^0.1.0',
 *     name: 'Blog Publisher',
 *     description: 'Publish markdown to a blog',
 *     permissions: ['fs:read', 'net', 'ai'],
 *     intents: ['publish', 'preview'],
 *     lifecycle: 'on-demand',
 *   },
 *   async load(ctx) { ctx.log.info('blog publisher ready') },
 *   async unload() {},
 *   async invoke(intent, ctx) {
 *     if (intent.kind === 'publish') {
 *       // intent.payload is narrowed to { md: string }
 *       return { ok: true, data: { url: '...' } }
 *     }
 *     if (intent.kind === 'preview') {
 *       return { ok: true, data: { html: '...' } }
 *     }
 *     return { ok: false, error: { code: 'unknown_intent', message: 'never' } }
 *   },
 * })
 */
export function defineModule<
  TIntent extends Intent<string, unknown> = Intent<string, unknown>,
>(module: Module<TIntent>): Module<TIntent> {
  const { manifest } = module
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('defineModule: manifest is required')
  }
  if (typeof manifest.id !== 'string' || !manifest.id) {
    throw new TypeError('defineModule: manifest.id must be a non-empty string')
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new TypeError('defineModule: manifest.version must be a non-empty string')
  }
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new TypeError('defineModule: manifest.name must be a non-empty string')
  }
  if (typeof manifest.description !== 'string' || !manifest.description) {
    throw new TypeError('defineModule: manifest.description must be a non-empty string')
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new TypeError('defineModule: manifest.permissions must be an array')
  }

  // ── Validate Agent24 optional fields when present ──────────────────────

  if (manifest.type !== undefined) {
    if (!(VALID_MODULE_TYPES as readonly string[]).includes(manifest.type)) {
      throw new TypeError(
        `defineModule: manifest.type must be one of ${VALID_MODULE_TYPES.map((t) => `'${t}'`).join(', ')} — got '${manifest.type}'`,
      )
    }
  }

  if (manifest.navItem !== undefined) {
    const { navItem } = manifest
    if (typeof navItem.icon !== 'string' || !navItem.icon) {
      throw new TypeError('defineModule: manifest.navItem.icon must be a non-empty string')
    }
    if (typeof navItem.label !== 'string' || !navItem.label) {
      throw new TypeError('defineModule: manifest.navItem.label must be a non-empty string')
    }
    if (typeof navItem.route !== 'string' || !navItem.route.startsWith('/')) {
      throw new TypeError("defineModule: manifest.navItem.route must be a string starting with '/'")
    }
  }

  if (manifest.container !== undefined) {
    const { container } = manifest
    if (typeof container.image !== 'string' || !container.image) {
      throw new TypeError('defineModule: manifest.container.image must be a non-empty string')
    }
    if (
      typeof container.port !== 'number' ||
      !Number.isInteger(container.port) ||
      container.port < 1 ||
      container.port > 65535
    ) {
      throw new TypeError(
        'defineModule: manifest.container.port must be an integer in range 1–65535',
      )
    }
    if (
      container.memoryMib !== undefined &&
      (!Number.isInteger(container.memoryMib) || container.memoryMib <= 0)
    ) {
      throw new TypeError(
        'defineModule: manifest.container.memoryMib must be a positive integer',
      )
    }
  }

  if (manifest.models !== undefined) {
    if (
      !Array.isArray(manifest.models) ||
      manifest.models.some((m) => typeof m !== 'string' || !m)
    ) {
      throw new TypeError(
        'defineModule: manifest.models must be an array of non-empty strings',
      )
    }
  }

  return module
}
