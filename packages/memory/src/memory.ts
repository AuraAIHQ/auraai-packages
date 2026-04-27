// L0 memory: namespaced key-value store backed by SQLite.
//
// Design:
// - Single SQLite file shared by all modules; namespaces isolate keys
//   to prevent collisions (`module.id` is the typical namespace).
// - Values are stored as JSON strings; structured types (objects,
//   arrays, numbers, booleans, null) round-trip; functions and other
//   non-JSON values are rejected at set time.
// - All operations are synchronous (better-sqlite3 is a sync driver) —
//   safe to call from main process; renderer should go through IPC.
// - `:memory:` filename is supported for tests.

import Database, { type Database as SqliteDb } from 'better-sqlite3'

export interface MemoryOptions {
  /**
   * Filesystem path to the sqlite database, or `:memory:` for an
   * in-process ephemeral DB (useful for tests).
   */
  filename: string
  /**
   * Optional namespace prefix. Each call key is stored as
   * `{namespace}:{key}` internally so different namespaces never
   * collide. Defaults to '' (root namespace).
   */
  namespace?: string
}

export interface Memory {
  /** Read a value. Returns null when the key is absent. */
  get<T = unknown>(key: string): T | null
  /** Write a value. Overwrites any existing entry for the same key. */
  set(key: string, value: unknown): void
  /** Remove a key. No-op if the key is absent. */
  delete(key: string): void
  /**
   * List keys in this namespace. If `prefix` is provided, returns only
   * keys starting with `prefix` (the prefix itself is matched against
   * the key portion, not the namespaced storage row).
   */
  list(prefix?: string): string[]
  /**
   * Derive a child memory scoped under the given sub-namespace. The
   * resulting full namespace is `{parent}:{child}` when the parent has
   * a namespace, otherwise just `{child}`.
   */
  namespace(child: string): Memory
  /** Close the underlying database connection. */
  close(): void
}

interface MemoryRow {
  value: string
}

const NAMESPACE_SEPARATOR = ':'

function joinNamespace(parent: string, child: string): string {
  if (!parent) return child
  if (!child) return parent
  return `${parent}${NAMESPACE_SEPARATOR}${child}`
}

function ensureSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_kv (
      ns_key TEXT PRIMARY KEY NOT NULL,
      value  TEXT NOT NULL
    ) WITHOUT ROWID;
  `)
  // Index on ns_key for prefix list — primary key index handles range scans
}

function makeMemory(db: SqliteDb, namespace: string, owned: boolean): Memory {
  const fullKey = (key: string): string => joinNamespace(namespace, key)

  // Use prepared statements for hot paths.
  const getStmt = db.prepare<[string], MemoryRow>(
    'SELECT value FROM memory_kv WHERE ns_key = ?',
  )
  const setStmt = db.prepare<[string, string]>(
    'INSERT INTO memory_kv (ns_key, value) VALUES (?, ?) ' +
      'ON CONFLICT(ns_key) DO UPDATE SET value = excluded.value',
  )
  const deleteStmt = db.prepare<[string]>('DELETE FROM memory_kv WHERE ns_key = ?')

  // Namespace prefix used by list(); we match `${namespace}:${userPrefix}*`
  // when namespace is set, otherwise `${userPrefix}*` directly. Use a
  // backslash as the LIKE ESCAPE character so we can treat user-supplied
  // %, _, and \ as literals.
  const listStmt = db.prepare<[string], { ns_key: string }>(
    "SELECT ns_key FROM memory_kv WHERE ns_key LIKE ? ESCAPE '\\'",
  )

  const escapeLike = (s: string): string =>
    // Escape backslash first to avoid double-escaping the escapes inserted below.
    s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')

  const decodePrefix = namespace ? `${namespace}${NAMESPACE_SEPARATOR}` : ''

  const memory: Memory = {
    get<T = unknown>(key: string): T | null {
      validateKey(key)
      const row = getStmt.get(fullKey(key))
      if (!row) return null
      return JSON.parse(row.value) as T
    },

    set(key: string, value: unknown): void {
      validateKey(key)
      const serialized = serializeValue(value)
      setStmt.run(fullKey(key), serialized)
    },

    delete(key: string): void {
      validateKey(key)
      deleteStmt.run(fullKey(key))
    },

    list(prefix?: string): string[] {
      const userPrefix = prefix ?? ''
      const pattern = `${escapeLike(decodePrefix)}${escapeLike(userPrefix)}%`
      const rows = listStmt.all(pattern)
      // Strip the namespace prefix to return user-facing keys
      return rows.map((row) => row.ns_key.slice(decodePrefix.length))
    },

    namespace(child: string): Memory {
      validateNamespacePart(child)
      // Children share the same db connection; closing them does NOT
      // close the parent. Only the owning Memory closes the db.
      return makeMemory(db, joinNamespace(namespace, child), false)
    },

    close(): void {
      if (owned) {
        db.close()
      }
      // child memories ignore close() — only the owner closes
    },
  }

  return memory
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('memory key must be a non-empty string')
  }
}

function validateNamespacePart(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('namespace must be a non-empty string')
  }
  if (name.includes(NAMESPACE_SEPARATOR)) {
    throw new TypeError(`namespace must not contain '${NAMESPACE_SEPARATOR}'`)
  }
}

function serializeValue(value: unknown): string {
  // JSON.stringify returns undefined for functions, undefined, and symbols.
  // Reject those at set time so we fail loudly rather than silently.
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`memory value must be JSON-serializable, got ${typeof value}`)
  }
  if (value === undefined) {
    throw new TypeError('memory value must be JSON-serializable, got undefined')
  }
  const result = JSON.stringify(value)
  if (result === undefined) {
    throw new TypeError('memory value is not JSON-serializable')
  }
  return result
}

/**
 * Create a new L0 memory backed by SQLite.
 *
 * @example
 * const mem = createMemory({ filename: ':memory:' })
 * mem.set('foo', { bar: 1 })
 * mem.get<{ bar: number }>('foo') // { bar: 1 }
 * const sub = mem.namespace('module-x')
 * sub.set('private', 'value')
 * sub.list()                       // ['private']
 * mem.list()                       // ['foo', 'module-x:private']
 * mem.close()
 */
export function createMemory(options: MemoryOptions): Memory {
  const { filename, namespace = '' } = options
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('createMemory: filename is required')
  }
  if (namespace) {
    validateNamespacePart(namespace)
  }
  const db = new Database(filename)
  // WAL mode improves concurrent reads; safe for our single-process usage.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  ensureSchema(db)
  return makeMemory(db, namespace, /* owned */ true)
}
