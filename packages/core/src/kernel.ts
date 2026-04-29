// In-memory module kernel for Agent24-Desktop.
//
// Responsibilities:
// - Maintain a registry of declared modules (id → record)
// - Topologically sort by manifest.dependencies and load in order
// - Construct each module's ModuleContext based on declared permissions
//   ONCE at load time, then reuse across invoke() calls (per SDK
//   contract: same ctx instance across the loaded module's lifetime)
// - Route invoke() calls; reject when module is not loaded
// - Surface lifecycle events for observability
// - Validate manifest.sdkVersion against kernel's supported SDK range
// - Serialize concurrent operations on the same module via an
//   activeOperations map (avoids races between load/unload/invoke)
//
// Out of scope (later milestones):
// - Sandboxing (worker_thread / child_process) — M1+ next task
// - npm install / module discovery from disk — M2
// - Signature verification + AirAccount trust — M3 (ADR-016)
// - manifest.intents-based routing — M2 (kernel.invoke takes id directly)
// - manifest.lifecycle ('persistent' / 'on-demand' / 'ephemeral')
//   scheduling — M2
// - Caller-permission enforcement on `module:invoke:{id}` — M2 when
//   the calling-module concept lands

import type {
  Module,
  ModuleContext,
  Intent,
  Result,
  Logger,
  AIHandle,
  MemoryHandle,
  Permission,
} from '@auraaihq/sdk'
import type { Memory } from '@auraaihq/memory'

/**
 * Kernel-supported SDK version range. Modules whose
 * `manifest.sdkVersion` is outside this range are rejected at
 * `register()`. M1 uses a simple string-prefix check (no semver
 * dependency); M2 will swap in a real `semver` package.
 */
const KERNEL_SDK_RANGE = '0.1' as const

/** Optional kernel logger; falls back to console when omitted. */
export interface KernelLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * State of a registered module. The kernel transitions records through
 * `registered → loaded → unloaded` and back. A failed load leaves the
 * record in `'failed'` with the error captured; `load(id)` on a
 * failed record re-throws the captured error rather than silently
 * retrying — call `register()` again with a fresh module instance to
 * retry, or use the new explicit `retry()` semantics (see `retryFailed`).
 */
export interface ModuleRecord {
  readonly module: Module
  readonly state: 'registered' | 'loading' | 'loaded' | 'unloading' | 'unloaded' | 'failed'
  readonly error?: Error
}

export interface KernelEvents {
  onModuleLoaded?(id: string): void
  onModuleUnloaded?(id: string): void
  onModuleFailed?(id: string, error: Error): void
}

export interface KernelOptions {
  /**
   * Backing memory store. Each module receives a namespaced child via
   * `memory.namespace(module.manifest.id)` when its manifest declares
   * memory permissions.
   */
  memory: Memory
  /** Optional kernel logger. Defaults to console. */
  log?: KernelLogger
  /**
   * AI handle the kernel will hand to modules with the `'ai'`
   * permission. M2 will replace this with the real ai-bridge router.
   */
  ai?: AIHandle
  /** Lifecycle event hooks. */
  events?: KernelEvents
}

export interface Kernel {
  register(module: Module): void
  has(id: string): boolean
  /** Snapshot of current module records. Cheap (returns the live
   * Map cast as readonly); callers must not mutate. */
  list(): ReadonlyMap<string, ModuleRecord>

  /**
   * Load one module by id. Loads its dependencies first (recursively).
   * Concurrent calls for the same id share a single in-flight
   * promise. No-op if already loaded. Re-throws the captured error
   * if the record is in 'failed' state — use `retry(id)` to attempt
   * re-load.
   */
  load(id: string): Promise<ModuleRecord>

  /**
   * Reset a 'failed' record back to 'registered' so the next load()
   * call starts fresh. No-op for non-failed records.
   */
  retry(id: string): void

  loadAll(options?: { continueOnError?: boolean }): Promise<{
    loaded: string[]
    failed: { id: string; error: Error }[]
  }>

  unload(id: string): Promise<void>
  invoke(moduleId: string, intent: Intent): Promise<Result>
  shutdown(): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

class CycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(`module dependency cycle detected: ${cycle.join(' → ')}`)
    this.name = 'CycleError'
  }
}

class UnknownModuleError extends Error {
  constructor(public readonly moduleId: string) {
    super(`unknown module: ${moduleId}`)
    this.name = 'UnknownModuleError'
  }
}

class NotLoadedError extends Error {
  constructor(
    public readonly moduleId: string,
    public readonly state: string,
  ) {
    super(`module '${moduleId}' is not loaded (state: ${state})`)
    this.name = 'NotLoadedError'
  }
}

class IncompatibleSdkVersionError extends Error {
  constructor(
    public readonly moduleId: string,
    public readonly moduleSdkVersion: string,
    public readonly kernelRange: string,
  ) {
    super(
      `module '${moduleId}' declares sdkVersion '${moduleSdkVersion}' but kernel supports range '${kernelRange}'`,
    )
    this.name = 'IncompatibleSdkVersionError'
  }
}

export {
  CycleError,
  UnknownModuleError,
  NotLoadedError,
  IncompatibleSdkVersionError,
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const defaultLogger: KernelLogger = {
  debug: (...args) => console.debug('[kernel]', ...args),
  info: (...args) => console.info('[kernel]', ...args),
  warn: (...args) => console.warn('[kernel]', ...args),
  error: (...args) => console.error('[kernel]', ...args),
}

function makeModuleLogger(parent: KernelLogger, moduleId: string): Logger {
  return {
    debug: (msg, ...args) => parent.debug(`[${moduleId}] ${msg}`, ...args),
    info: (msg, ...args) => parent.info(`[${moduleId}] ${msg}`, ...args),
    warn: (msg, ...args) => parent.warn(`[${moduleId}] ${msg}`, ...args),
    error: (msg, ...args) => parent.error(`[${moduleId}] ${msg}`, ...args),
  }
}

function permissionsAllowMemory(
  permissions: readonly Permission[],
): { read: boolean; write: boolean } {
  return {
    read: permissions.includes('memory:read'),
    write: permissions.includes('memory:write'),
  }
}

function makeMemoryHandle(memory: Memory, permissions: readonly Permission[]): MemoryHandle {
  const { read, write } = permissionsAllowMemory(permissions)
  if (!read && !write) {
    throw new Error('makeMemoryHandle called for module without memory permissions')
  }
  const denyWrite = (op: string): never => {
    throw new Error(`module lacks 'memory:write' permission for ${op}`)
  }
  return {
    get: (key) => memory.get(key),
    has: (key) => memory.has(key),
    set: write ? (key, value) => memory.set(key, value) : () => denyWrite('set'),
    delete: write ? (key) => memory.delete(key) : () => denyWrite('delete'),
    list: (prefix) => memory.list(prefix),
    namespace: (child) => makeMemoryHandle(memory.namespace(child), permissions),
  }
}

function buildContext(
  module: Module,
  options: KernelOptions,
  log: KernelLogger,
): ModuleContext {
  const { manifest } = module
  const moduleLog = makeModuleLogger(log, manifest.id)

  const ctx: Mutable<ModuleContext> = {
    manifest,
    log: moduleLog,
  }

  if (manifest.permissions.includes('ai')) {
    if (options.ai) {
      ctx.ai = options.ai
    } else {
      moduleLog.warn(
        "module declares 'ai' permission but kernel has no AI handle configured",
      )
    }
  }

  const memPerms = permissionsAllowMemory(manifest.permissions)
  if (memPerms.read || memPerms.write) {
    const moduleMemory = options.memory.namespace(manifest.id)
    ctx.memory = makeMemoryHandle(moduleMemory, manifest.permissions)
  }

  // fs/net permissions are declared in the SDK but not yet enforced.
  // Modules may still use Node.js APIs directly; this warning is the
  // only guard until M2 adds sandbox/capability enforcement.
  const hasUnenforced = manifest.permissions.some(
    (p) => p === 'fs:read' || p === 'fs:write' || p === 'net',
  )
  if (hasUnenforced) {
    moduleLog.warn(
      "fs/net permissions declared but not enforced in M1 — " +
        "modules may call Node.js APIs directly; sandbox enforcement is deferred to M2",
    )
  }

  return ctx
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
// Internal record — extends the public ModuleRecord with the runtime context
// that the kernel needs for invoke(). Never exposed through list() or load().
type KernelRecord = Mutable<ModuleRecord> & { context?: ModuleContext }

/**
 * Validate that a module's declared sdkVersion is compatible with the
 * kernel's supported range. M1 uses a simple major.minor prefix
 * check; M2 will swap in real semver.
 */
function isSdkVersionCompatible(moduleSdkVersion: string, kernelRange: string): boolean {
  // Allow caret (^), tilde (~), explicit version, or range strings —
  // for the simplified M1 check, strip leading ^/~ and require the
  // major.minor prefix to match the kernel range.
  const stripped = moduleSdkVersion.replace(/^[\^~]/, '').trim()
  if (stripped.length === 0) return false
  const parts = stripped.split('.')
  const major = parts[0]
  const minor = parts[1]
  if (major === undefined || minor === undefined) return false
  return `${major}.${minor}` === kernelRange
}

function topoSort(records: Map<string, ModuleRecord>): string[] {
  const result: string[] = []
  const VISITING = 1
  const VISITED = 2
  const marks = new Map<string, number>()

  function visit(id: string, path: string[]): void {
    const mark = marks.get(id)
    if (mark === VISITED) return
    if (mark === VISITING) {
      const cycleStart = path.indexOf(id)
      throw new CycleError([...path.slice(cycleStart), id])
    }
    const record = records.get(id)
    if (!record) {
      // missing dep is reported separately by the caller; topo skips it
      // so the rest of the graph can still load (the caller will fail
      // the unknown-dep load before invocation).
      return
    }
    marks.set(id, VISITING)
    const deps = record.module.manifest.dependencies ?? []
    for (const dep of deps) {
      visit(dep, [...path, id])
    }
    marks.set(id, VISITED)
    result.push(id)
  }

  for (const id of records.keys()) {
    visit(id, [])
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

export function createKernel(options: KernelOptions): Kernel {
  const log = options.log ?? defaultLogger
  // Internal records use Mutable<ModuleRecord> so the kernel can update
  // state/error/context. list() exposes them as ReadonlyMap<string, ModuleRecord>
  // so callers get compile-time readonly semantics without a copy allocation.
  const records = new Map<string, KernelRecord>()
  const loadOrder: string[] = []  // ids in the order they finished loading

  // Active in-flight load/unload promises, keyed by module id.
  // Concurrent callers for the same id share a promise — avoids
  // double-load races and re-entrancy bugs.
  const inFlightLoads = new Map<string, Promise<KernelRecord>>()
  const inFlightUnloads = new Map<string, Promise<void>>()

  // Shutdown flag — once set, new operations short-circuit.
  let shuttingDown = false

  const kernel: Kernel = {
    register(module) {
      if (shuttingDown) {
        throw new Error('kernel is shutting down; register rejected')
      }
      const id = module.manifest.id
      const existing = records.get(id)
      if (existing && existing.module !== module) {
        throw new Error(
          `module '${id}' is already registered with a different instance — refusing silent override`,
        )
      }
      if (existing) return // idempotent

      // Validate sdkVersion compatibility. Modules without sdkVersion
      // get a warning (legacy) but are accepted; modules with an
      // incompatible version are rejected.
      const declared = module.manifest.sdkVersion
      if (declared !== undefined) {
        if (!isSdkVersionCompatible(declared, KERNEL_SDK_RANGE)) {
          throw new IncompatibleSdkVersionError(id, declared, KERNEL_SDK_RANGE)
        }
      } else {
        log.warn(
          `module '${id}' has no sdkVersion in manifest; compatibility cannot be verified`,
        )
      }

      records.set(id, { module, state: 'registered' } as KernelRecord)
      log.debug(`registered module: ${id}`)
    },

    has(id) {
      return records.has(id)
    },

    list() {
      // Expose internal map as ReadonlyMap<string, ModuleRecord>. Callers
      // get compile-time readonly fields without a per-call copy. The cast
      // is sound because Mutable<ModuleRecord> satisfies ModuleRecord's
      // readonly-field contract from the caller's perspective.
      return records as unknown as ReadonlyMap<string, ModuleRecord>
    },

    retry(id) {
      const record = records.get(id)
      if (!record) throw new UnknownModuleError(id)
      if (record.state === 'failed') {
        record.state = 'registered'
        record.error = undefined
        log.info(`retry: reset module '${id}' from failed → registered`)
      }
    },

    async load(id) {
      if (shuttingDown) {
        throw new Error('kernel is shutting down; load rejected')
      }
      const record = records.get(id)
      if (!record) throw new UnknownModuleError(id)
      if (record.state === 'loaded') return record
      if (record.state === 'failed') {
        // Don't silently retry. Surface the captured error and let
        // the caller decide whether to retry() and re-attempt.
        throw record.error ?? new Error(`module '${id}' is in failed state`)
      }

      // Coalesce concurrent loads on the same id: subsequent callers
      // wait for the in-flight promise instead of starting a parallel
      // load that could race on record.state.
      const existing = inFlightLoads.get(id)
      if (existing) return existing

      const loadPromise = (async (): Promise<KernelRecord> => {
        // Validate deps exist before doing anything else.
        const deps = record.module.manifest.dependencies ?? []
        for (const dep of deps) {
          if (!records.has(dep)) {
            throw new UnknownModuleError(`${dep} (dependency of ${id})`)
          }
        }

        // Recursively load deps first (will share inFlightLoads if any
        // are concurrent).
        for (const dep of deps) {
          await kernel.load(dep)
        }

        record.state = 'loading'
        try {
          const ctx = buildContext(record.module, options, log)
          await record.module.load(ctx)
          record.state = 'loaded'
          record.context = ctx  // Per SDK contract: same ctx for invokes
          loadOrder.push(id)
          log.info(`loaded module: ${id}`)
          options.events?.onModuleLoaded?.(id)
          return record
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          record.state = 'failed'
          record.error = err
          log.error(`failed to load module '${id}':`, err)
          options.events?.onModuleFailed?.(id, err)
          throw err
        }
      })()

      inFlightLoads.set(id, loadPromise)
      try {
        return await loadPromise
      } finally {
        inFlightLoads.delete(id)
      }
    },

    async loadAll(opts) {
      if (shuttingDown) {
        throw new Error('kernel is shutting down; loadAll rejected')
      }
      const continueOnError = opts?.continueOnError ?? false
      const order = topoSort(records)
      const loaded: string[] = []
      const failed: { id: string; error: Error }[] = []
      const failedIds = new Set<string>()

      for (const id of order) {
        // Skip already-loaded modules silently (saves duplicate work
        // when loadAll is called multiple times).
        const r = records.get(id)
        if (r?.state === 'loaded') {
          loaded.push(id)
          continue
        }

        // Skip modules whose dependencies failed — avoids misleading
        // errors where the root cause is the dependency, not this module.
        const deps = r?.module.manifest.dependencies ?? []
        const blockedBy = deps.find((dep) => failedIds.has(dep))
        if (blockedBy) {
          const err = new Error(
            `skipped: dependency '${blockedBy}' failed to load`,
          )
          failed.push({ id, error: err })
          failedIds.add(id)
          if (!continueOnError) break
          continue
        }

        try {
          await kernel.load(id)
          loaded.push(id)
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          failed.push({ id, error: err })
          failedIds.add(id)
          if (!continueOnError) break
        }
      }
      return { loaded, failed }
    },

    async unload(id) {
      const record = records.get(id)
      if (!record) throw new UnknownModuleError(id)
      if (record.state !== 'loaded') return // no-op

      // Coalesce concurrent unloads on the same id.
      const existing = inFlightUnloads.get(id)
      if (existing) return existing

      const unloadPromise = (async (): Promise<void> => {
        // Unload dependents first.
        const dependents = [...records.values()].filter((r) =>
          r.module.manifest.dependencies?.includes(id),
        )
        for (const dependent of dependents) {
          if (dependent.state === 'loaded') {
            await kernel.unload(dependent.module.manifest.id)
          }
        }

        record.state = 'unloading'
        try {
          await record.module.unload()
          record.state = 'unloaded'
          record.context = undefined  // release ctx reference
          const idx = loadOrder.indexOf(id)
          if (idx >= 0) loadOrder.splice(idx, 1)
          log.info(`unloaded module: ${id}`)
          options.events?.onModuleUnloaded?.(id)
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          record.state = 'failed'
          record.error = err
          // Remove from loadOrder even on failure — otherwise a subsequent
          // retry() + load() would add a second entry and cause double-unload
          // during shutdown.
          const idx = loadOrder.indexOf(id)
          if (idx >= 0) loadOrder.splice(idx, 1)
          log.error(`failed to unload module '${id}':`, err)
          throw err
        }
      })()

      inFlightUnloads.set(id, unloadPromise)
      try {
        await unloadPromise
      } finally {
        inFlightUnloads.delete(id)
      }
    },

    async invoke(moduleId, intent) {
      const record = records.get(moduleId)
      if (!record) throw new UnknownModuleError(moduleId)
      if (record.state !== 'loaded') {
        throw new NotLoadedError(moduleId, record.state)
      }
      // Reuse the ctx built at load time — per SDK contract, modules
      // see the SAME ctx instance across all invoke() calls for the
      // current loaded lifetime.
      if (!record.context) {
        // Defensive: should never happen for a 'loaded' record.
        throw new Error(
          `internal: module '${moduleId}' is loaded but has no context`,
        )
      }
      return record.module.invoke(intent, record.context)
    },

    async shutdown() {
      if (shuttingDown) return  // idempotent
      shuttingDown = true

      // Wait for any in-flight load/unload to settle so we don't race
      // their state transitions.
      const pending: Promise<unknown>[] = []
      for (const p of inFlightLoads.values()) pending.push(p.catch(() => {}))
      for (const p of inFlightUnloads.values()) pending.push(p.catch(() => {}))
      if (pending.length > 0) {
        log.debug(`shutdown: awaiting ${pending.length} in-flight operation(s)`)
        await Promise.all(pending)
      }

      // Unload in reverse load order to respect dependency relationships.
      const reverseOrder = [...loadOrder].reverse()
      for (const id of reverseOrder) {
        try {
          await kernel.unload(id)
        } catch (error) {
          log.error(`shutdown: failed to unload '${id}', continuing:`, error)
        }
      }
    },
  }

  return kernel
}
