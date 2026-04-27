import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type Memory } from './memory'

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
      expect(mem.get('z')).toBeNull() // can't distinguish from absent — known limitation
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
  })

  describe('list', () => {
    beforeEach(() => {
      mem.set('a:1', 1)
      mem.set('a:2', 2)
      mem.set('b:1', 3)
    })

    it('lists all keys with empty prefix', () => {
      expect(mem.list().sort()).toEqual(['a:1', 'a:2', 'b:1'])
    })

    it('filters by prefix', () => {
      expect(mem.list('a:').sort()).toEqual(['a:1', 'a:2'])
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

    it('child namespace operations are visible from root with prefix', () => {
      const sub = mem.namespace('sub')
      sub.set('inner', 'x')
      expect(mem.get('sub:inner')).toBe('x')
    })

    it('nested namespaces compose with separator', () => {
      const a = mem.namespace('a')
      const b = a.namespace('b')
      b.set('k', 1)
      expect(mem.get('a:b:k')).toBe(1)
    })

    it('list() in a namespace returns user-facing keys (no prefix)', () => {
      const sub = mem.namespace('sub')
      sub.set('one', 1)
      sub.set('two', 2)
      expect(sub.list().sort()).toEqual(['one', 'two'])
    })

    it('list() in root sees namespaced rows', () => {
      const sub = mem.namespace('sub')
      sub.set('x', 1)
      mem.set('y', 2)
      expect(mem.list().sort()).toEqual(['sub:x', 'y'])
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
})
