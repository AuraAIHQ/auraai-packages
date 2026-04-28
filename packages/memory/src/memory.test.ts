import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, MemoryCorruptionError, type Memory } from './memory'

describe('@auraaihq/memory L0', () => {
  let mem: Memory

  beforeEach(() => {
    mem = createMemory({ filename: ':memory:' })
  })

  afterEach(() => {
    mem.close()
  })

  describe('basic get/set/delete', () => {
    it('returns null for missing key', () => {
      expect(mem.get('absent')).toBeNull()
    })

    it('round-trips strings', () => {
      mem.set('greeting', 'hello')
      expect(mem.get('greeting')).toBe('hello')
    })

    it('round-trips structured types', () => {
      const value = { count: 42, items: [1, 2, 3], nested: { ok: true } }
      mem.set('obj', value)
      expect(mem.get('obj')).toEqual(value)
    })

    it('round-trips primitives (number, boolean, null)', () => {
      mem.set('n', 42)
      mem.set('b', true)
      mem.set('z', null)
      expect(mem.get<number>('n')).toBe(42)
      expect(mem.get<boolean>('b')).toBe(true)
      expect(mem.get('z')).toBeNull()
      // null vs absent is now disambiguated via has()
      expect(mem.has('z')).toBe(true)
      expect(mem.has('not-set')).toBe(false)
    })

    it('overwrites existing keys', () => {
      mem.set('k', 1)
      mem.set('k', 2)
      expect(mem.get<number>('k')).toBe(2)
    })

    it('deletes keys', () => {
      mem.set('temp', 'x')
      expect(mem.get('temp')).toBe('x')
      mem.delete('temp')
      expect(mem.get('temp')).toBeNull()
    })

    it('delete is idempotent on missing keys', () => {
      expect(() => mem.delete('absent')).not.toThrow()
    })
  })

  describe('has()', () => {
    it('returns false for missing keys', () => {
      expect(mem.has('absent')).toBe(false)
    })

    it('returns true after set, even when value is null', () => {
      mem.set('explicit-null', null)
      expect(mem.has('explicit-null')).toBe(true)
    })

    it('returns true for any stored value', () => {
      mem.set('s', 'string')
      mem.set('n', 0)
      mem.set('b', false)
      mem.set('o', {})
      expect(mem.has('s')).toBe(true)
      expect(mem.has('n')).toBe(true)
      expect(mem.has('b')).toBe(true)
      expect(mem.has('o')).toBe(true)
    })

    it('returns false after delete', () => {
      mem.set('temp', 1)
      mem.delete('temp')
      expect(mem.has('temp')).toBe(false)
    })

    it('rejects empty key', () => {
      expect(() => mem.has('')).toThrow(TypeError)
    })

    it('rejects key containing namespace separator', () => {
      expect(() => mem.has('a:b')).toThrow(TypeError)
    })
  })

  describe('input validation', () => {
    it('rejects empty key', () => {
      expect(() => mem.get('')).toThrow(TypeError)
      expect(() => mem.set('', 1)).toThrow(TypeError)
      expect(() => mem.delete('')).toThrow(TypeError)
    })

    it('rejects functions, symbols, undefined values', () => {
      expect(() => mem.set('k', () => 1)).toThrow(TypeError)
      expect(() => mem.set('k', Symbol('x'))).toThrow(TypeError)
      expect(() => mem.set('k', undefined)).toThrow(TypeError)
    })

    it('rejects key containing namespace separator (prevents collision)', () => {
      // Without this rejection, mem.set('user:balance') and
      // mem.namespace('user').set('balance') would collide silently.
      expect(() => mem.set('user:balance', 100)).toThrow(/namespace separator/)
      expect(() => mem.get('user:balance')).toThrow(/namespace separator/)
      expect(() => mem.delete('user:balance')).toThrow(/namespace separator/)
    })

    it('rejects key containing separator anywhere (not just prefix)', () => {
      expect(() => mem.set('foo:bar:baz', 1)).toThrow(/namespace separator/)
      expect(() => mem.set('trailing:', 1)).toThrow(/namespace separator/)
      expect(() => mem.set(':leading', 1)).toThrow(/namespace separator/)
    })
  })

  describe('list', () => {
    beforeEach(() => {
      mem.set('a-1', 1)
      mem.set('a-2', 2)
      mem.set('b-1', 3)
    })

    it('lists all keys with empty prefix', () => {
      expect(mem.list().sort()).toEqual(['a-1', 'a-2', 'b-1'])
    })

    it('filters by prefix', () => {
      expect(mem.list('a-').sort()).toEqual(['a-1', 'a-2'])
    })

    it('returns empty array for non-matching prefix', () => {
      expect(mem.list('zzz')).toEqual([])
    })

    it('escapes SQL LIKE special chars in prefix', () => {
      mem.set('100%off', 'x')
      mem.set('100x', 'y')
      // '%' should be treated literally, not as wildcard
      expect(mem.list('100%').sort()).toEqual(['100%off'])
    })

    it('escapes underscore wildcard', () => {
      mem.set('abc', 1)
      mem.set('a_c', 2)
      // '_' should be treated literally, not match any single char
      expect(mem.list('a_').sort()).toEqual(['a_c'])
    })

    it('escapes backslash literal', () => {
      mem.set('a\\b', 1)
      mem.set('axb', 2)
      // backslash is literal, not escape
      expect(mem.list('a\\').sort()).toEqual(['a\\b'])
    })
  })

  describe('namespaces', () => {
    it('isolates keys between namespaces', () => {
      const a = mem.namespace('module-a')
      const b = mem.namespace('module-b')
      a.set('shared-key', 'a-value')
      b.set('shared-key', 'b-value')
      expect(a.get('shared-key')).toBe('a-value')
      expect(b.get('shared-key')).toBe('b-value')
    })

    it('child namespace storage uses internal separator (visible from root)', () => {
      const sub = mem.namespace('sub')
      sub.set('inner', 'x')
      // Root cannot read with the synthetic 'sub:inner' key directly —
      // it would be rejected because keys can't contain the separator.
      expect(() => mem.get('sub:inner')).toThrow(/namespace separator/)
      // Reading it requires going through the same namespace.
      const sub2 = mem.namespace('sub')
      expect(sub2.get('inner')).toBe('x')
    })

    it('list() in root excludes child namespace keys', () => {
      const sub = mem.namespace('sub')
      sub.set('x', 1)
      mem.set('y', 2)
      // Only direct keys of the root namespace are returned.
      // 'sub:x' lives in the 'sub' child namespace and is excluded.
      // Use mem.namespace('sub').list() to inspect child keys.
      expect(mem.list().sort()).toEqual(['y'])
    })

    it('list() in child namespace only returns that namespace\'s direct keys', () => {
      const sub = mem.namespace('sub')
      sub.set('x', 1)
      sub.set('y', 2)
      mem.set('root-key', 0)
      expect(sub.list().sort()).toEqual(['x', 'y'])
    })

    it('nested namespaces compose with separator', () => {
      const a = mem.namespace('a')
      const b = a.namespace('b')
      b.set('k', 1)
      // Reading via the same nested namespace works
      expect(a.namespace('b').get<number>('k')).toBe(1)
    })

    it('list() in a namespace returns user-facing keys (no prefix)', () => {
      const sub = mem.namespace('sub')
      sub.set('one', 1)
      sub.set('two', 2)
      expect(sub.list().sort()).toEqual(['one', 'two'])
    })

    it('rejects namespace containing separator', () => {
      expect(() => mem.namespace('a:b')).toThrow(TypeError)
    })

    it('rejects empty namespace', () => {
      expect(() => mem.namespace('')).toThrow(TypeError)
    })

    it('child close() does not close parent db', () => {
      const sub = mem.namespace('sub')
      sub.close()
      // parent should still work
      expect(() => mem.set('still-works', 1)).not.toThrow()
      expect(mem.get<number>('still-works')).toBe(1)
    })

    it('namespace isolation: collision with explicit colon key is impossible (key rejected)', () => {
      // Without the validateKey separator rejection, this scenario
      // would silently collide:
      //   mem.set('user:balance', 999)
      //   mem.namespace('user').set('balance', 100)  // overwrites root's value
      // Now the first call throws instead.
      expect(() => mem.set('user:balance', 999)).toThrow(/namespace separator/)
      // The legitimate path works:
      const userMem = mem.namespace('user')
      userMem.set('balance', 100)
      expect(userMem.get<number>('balance')).toBe(100)
    })
  })

  describe('close() ownership', () => {
    it('child operations after owner close throw a clear error', () => {
      const sub = mem.namespace('sub')
      sub.set('before', 'ok')
      mem.close()
      expect(() => sub.get('before')).toThrow(/database connection is closed/)
      expect(() => sub.set('after', 1)).toThrow(/database connection is closed/)
      expect(() => sub.list()).toThrow(/database connection is closed/)
      expect(() => sub.has('before')).toThrow(/database connection is closed/)
      // Re-open for afterEach (it'll just call close on already-closed,
      // which is now safe via the db.open guard).
      mem = createMemory({ filename: ':memory:' })
    })

    it('owner close() is idempotent', () => {
      const m = createMemory({ filename: ':memory:' })
      m.close()
      expect(() => m.close()).not.toThrow()
    })
  })

  describe('createMemory options', () => {
    it('rejects empty filename', () => {
      expect(() => createMemory({ filename: '' })).toThrow(TypeError)
    })

    it('accepts initial namespace', () => {
      const m = createMemory({ filename: ':memory:', namespace: 'init' })
      m.set('k', 'v')
      expect(m.get('k')).toBe('v')
      m.close()
    })

    it('rejects initial namespace containing separator', () => {
      expect(() => createMemory({ filename: ':memory:', namespace: 'a:b' })).toThrow(TypeError)
    })
  })

  describe('corruption handling', () => {
    it('throws MemoryCorruptionError when stored JSON is malformed', () => {
      // Use a temp file so we can corrupt it via a second connection
      // and verify createMemory's read path classifies the failure.
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const fs = require('node:fs') as typeof import('node:fs')
      const os = require('node:os') as typeof import('node:os')
      const path = require('node:path') as typeof import('node:path')
      const tmpFile = path.join(
        os.tmpdir(),
        `memory-corrupt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      )
      try {
        // Step 1: create with our helper, write a value.
        const m1 = createMemory({ filename: tmpFile })
        m1.set('broken', 'normal-value')
        m1.close()

        // Step 2: corrupt the row via raw sqlite.
        const direct = new Database(tmpFile)
        direct
          .prepare('UPDATE memory_kv SET value = ? WHERE ns_key = ?')
          .run('{not valid json', 'broken')
        direct.close()

        // Step 3: reopen with memory layer and try to read — should
        // throw MemoryCorruptionError, NOT a raw SyntaxError.
        const m2 = createMemory({ filename: tmpFile })
        try {
          expect(() => m2.get('broken')).toThrow(MemoryCorruptionError)
        } finally {
          m2.close()
        }
      } finally {
        try {
          fs.unlinkSync(tmpFile)
          fs.unlinkSync(`${tmpFile}-shm`)
          fs.unlinkSync(`${tmpFile}-wal`)
        } catch {
          // ignore — WAL files may not exist
        }
      }
    })

    it('MemoryCorruptionError preserves the original parse error as cause', () => {
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const fs = require('node:fs') as typeof import('node:fs')
      const os = require('node:os') as typeof import('node:os')
      const path = require('node:path') as typeof import('node:path')
      const tmpFile = path.join(
        os.tmpdir(),
        `memory-corrupt-cause-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      )
      try {
        const m1 = createMemory({ filename: tmpFile })
        m1.set('k', 1)
        m1.close()

        const direct = new Database(tmpFile)
        direct
          .prepare('UPDATE memory_kv SET value = ? WHERE ns_key = ?')
          .run('garbage', 'k')
        direct.close()

        const m2 = createMemory({ filename: tmpFile })
        try {
          let caught: unknown
          try {
            m2.get('k')
          } catch (e) {
            caught = e
          }
          expect(caught).toBeInstanceOf(MemoryCorruptionError)
          expect((caught as MemoryCorruptionError).key).toBe('k')
          expect((caught as MemoryCorruptionError).cause).toBeInstanceOf(Error)
        } finally {
          m2.close()
        }
      } finally {
        try {
          fs.unlinkSync(tmpFile)
          fs.unlinkSync(`${tmpFile}-shm`)
          fs.unlinkSync(`${tmpFile}-wal`)
        } catch {
          // ignore
        }
      }
    })
  })

  describe('busy_timeout pragma', () => {
    it('is set on file-backed databases', () => {
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const fs = require('node:fs') as typeof import('node:fs')
      const os = require('node:os') as typeof import('node:os')
      const path = require('node:path') as typeof import('node:path')
      const tmpFile = path.join(
        os.tmpdir(),
        `memory-busy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      )
      try {
        const m = createMemory({ filename: tmpFile })
        // Verify pragma via a separate read connection
        const probe = new Database(tmpFile)
        const result = probe.pragma('busy_timeout', { simple: true })
        expect(result).toBe(5000)
        probe.close()
        m.close()
      } finally {
        try {
          fs.unlinkSync(tmpFile)
          fs.unlinkSync(`${tmpFile}-shm`)
          fs.unlinkSync(`${tmpFile}-wal`)
        } catch {
          // ignore
        }
      }
    })
  })
})
