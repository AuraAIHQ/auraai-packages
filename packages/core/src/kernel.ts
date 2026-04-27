// In-memory module kernel for Agent24-Desktop.
//
// Responsibilities:
// - Maintain a registry of declared modules (id → record)
// - Topologically sort by manifest.dependencies and load in order
// - Construct each module's ModuleContext based on declared permissions
// - Route invoke() calls; reject when module is not loaded
// - Surface lifecycle events for observability
//
// Out of scope (later milestones):
// - Sandboxing (worker_thread / child_process) — M1+ next task
// - npm install / module discovery from disk — M2
// - Signature verification + AirAccount trust — M3 (ADR-016)
// - Module-to-module invoke graph cycle detection across deps — done
//   here for the simple case; optimised pass arrives in M2

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

/** Optional kernel logger; falls back to console when omitted. */
export interface KernelLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * State of a registered module. The kernel transitions records through
 * `registered → loaded → unloaded` and back. A failed load returns the
 * record to `registered` with the error captured.
 */
export interface ModuleRecord {
  readonly module: Module
  state: 'registered' | 'loading' | 'loaded' | 'unloading' | 'unloaded' | 'failed'
  error?: Error
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
  /**
   * Register a module so it can later be loaded. Idempotent for the
   * same id only if the same Module instance is registered; otherwise
   * throws to prevent silent overrides.
   */
  register(module: Module): void

  /** Whether a module is registered (regardless of load state). */
  has(id: string): boolean

  /** Snapshot of current module records, keyed by id. */
  list(): ReadonlyMap<string, ModuleRecord>

  /**
   * Load one module by id. Loads its dependencies first (recursively).
   * No-op if already loaded. Returns the record on success; throws
   * with detailed cause on failure.
   */
  load(id: string): Promise<ModuleRecord>

  /**
   * Load every registered module in dependency-topological order.
   * Stops at first failure unless `options.continueOnError` is set.
   */
  loadAll(options?: { continueOnError?: boolean }): Promise<{
    loaded: string[]
    failed: { id: string; error: Error }[]
  }>

  /**
   * Unload a module. Cycles through children that depend on it first.
   * No-op if not currently loaded.
   */
  unload(id: string): Promise<void>

  /**
   * Route an intent to the named module. Throws if the module is not
   * loaded; otherwise returns the module's Result verbatim.
   */
  invoke(moduleId: string, intent: Intent): Promise<Result>

  /** Unload everything in reverse-load order; cleans up the registry. */
  shutdown(): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
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
  constructor(public readonly moduleId: string, public readonly state: string) {
    super(`module '${moduleId}' is not loaded (state: ${state})`)
    this.name = 'NotLoadedError'
  }
}

export { CycleError, UnknownModuleError, NotLoadedError }

const defaultLogger: KernelLogger = {
  debug: (...args) => console.debug('[kernel]', ...args),
  info: (...args) => console.info('[kernel]', ...args),
  warn: (...args) => console.warn('[kernel]', ...args),
  error: (...args) => console.error('[kernel]', ...args),
}

/**
 * Tag a logger with a module id prefix. Returned as the `log` field
 * inside ModuleContext.
 */
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

/**
 * Build a memory handle that respects the module's declared permissions:
 * if only read permission, mutations throw at runtime.
 */
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
    set: write ? (key, value) => memory.set(key, value) : () => denyWrite('set'),
    delete: write ? (key) => memory.delete(key) : () => denyWrite('delete'),
    list: (prefix) => memory.list(prefix),
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

  // AI handle: present iff module declares 'ai' AND kernel has one.
  if (manifest.permissions.includes('ai')) {
    if (options.ai) {
      ctx.ai = options.ai
    } else {
      moduleLog.warn(
        "module declares 'ai' permission but kernel has no AI handle configured",
      )
    }
  }

  // Memory handle: present iff module declares any memory permission.
  const memPerms = permissionsAllowMemory(manifest.permissions)
  if (memPerms.read || memPerms.write) {
    const moduleMemory = options.memory.namespace(manifest.id)
    ctx.memory = makeMemoryHandle(moduleMemory, manifest.permissions)
  }

  return ctx
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Topologically sort modules by their manifest.dependencies. Returns
 * an order such that every dependency precedes the modules that need
 * it. Throws CycleError on a cycle.
 */
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

export function createKernel(options: KernelOptions): Kernel {
  const log = options.log ?? defaultLogger
  const records = new Map<string, ModuleRecord>()
  const loadOrder: string[] = []  // ids in the order they finished loading

  const kernel: Kernel = {
    register(module) {
      const id = module.manifest.id
      const existing = records.get(id)
      if (existing && existing.module !== module) {
        throw new Error(
          `module '${id}' is already registered with a different instance — refusing silent override`,
        )
      }
      if (existing) return // idempotent
      records.set(id, { module, state: 'registered' })
      log.debug(`registered module: ${id}`)
    },

    has(id) {
      return records.has(id)
    },

    list() {
      return new Map(records)
    },

    async load(id) {
      const record = records.get(id)
      if (!record) throw new UnknownModuleError(id)
      if (record.state === 'loaded') return record
      if (record.state === 'loading') {
        throw new Error(`module '${id}' is already loading (re-entrancy)`)
      }

      // Validate deps exist before doing anything.
      const deps = record.module.manifest.dependencies ?? []
      for (const dep of deps) {
        if (!records.has(dep)) {
          throw new UnknownModuleError(`${dep} (dependency of ${id})`)
        }
      }

      // Recursively load deps first.
      for (const dep of deps) {
        await kernel.load(dep)
      }

      record.state = 'loading'
      try {
        const ctx = buildContext(record.module, options, log)
        await record.module.load(ctx)
        record.state = 'loaded'
        loadOrder.push(id)
        log.info(`loaded module: ${id}`)
        options.events?.onModuleLoaded?.(id)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        record.state = 'failed'
        record.error = err
        log.error(`failed to load module '${id}':`, err)
        options.events?.onModuleFailed?.(id, err)
        throw err
      }
      return record
    },

    async loadAll(opts) {
      const continueOnError = opts?.continueOnError ?? false
      const order = topoSort(records)
      const loaded: string[] = []
      const failed: { id: string; error: Error }[] = []

      for (const id of order) {
        try {
          await kernel.load(id)
          loaded.push(id)
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          failed.push({ id, error: err })
          if (!continueOnError) break
        }
      }
      return { loaded, failed }
    },

    async unload(id) {
      const record = records.get(id)
      if (!record) throw new UnknownModuleError(id)
      if (record.state !== 'loaded') return // no-op

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
        const idx = loadOrder.indexOf(id)
        if (idx >= 0) loadOrder.splice(idx, 1)
        log.info(`unloaded module: ${id}`)
        options.events?.onModuleUnloaded?.(id)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        record.state = 'failed'
        record.error = err
        log.error(`failed to unload module '${id}':`, err)
        throw err
      }
    },

    async invoke(moduleId, intent) {
      const record = records.get(moduleId)
      if (!record) throw new UnknownModuleError(moduleId)
      if (record.state !== 'loaded') {
        throw new NotLoadedError(moduleId, record.state)
      }
      const ctx = buildContext(record.module, options, log)
      return record.module.invoke(intent, ctx)
    },

    async shutdown() {
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
