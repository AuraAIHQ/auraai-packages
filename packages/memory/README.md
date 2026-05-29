# @auraaihq/memory

> Layered memory system for Agent24. M1 ships **L0** (key-value, namespace-scoped, SQLite-backed). L1-L3 + SkillBank arrive in M3.

## Status

M0 placeholder → M1 implementation in progress. Currently provides the L0 KV layer; layered tiers and SkillBank coming in M3.

## Quick start

```ts
import { createMemory } from '@auraaihq/memory'

const mem = createMemory({ filename: '/path/to/agent24.db' })

mem.set('user:profile', { name: 'jason', tz: 'Asia/Bangkok' })
const profile = mem.get<{ name: string; tz: string }>('user:profile')

// Module-scoped sub-namespace (recommended pattern)
const myModule = mem.namespace('publish-twitter')
myModule.set('last-post-id', '12345')
myModule.list()                  // ['last-post-id']
mem.list()                       // ['user:profile', 'publish-twitter:last-post-id']

mem.close()
```

## API

| Method | Description |
|--------|-------------|
| `createMemory({ filename, namespace? })` | Open or create the SQLite-backed memory store |
| `mem.get<T>(key)` | Read a value; returns `null` when absent |
| `mem.set(key, value)` | Write any JSON-serializable value |
| `mem.delete(key)` | Remove a key (no-op if absent) |
| `mem.list(prefix?)` | List keys in this namespace, optionally filtered by prefix |
| `mem.namespace(child)` | Derive a child memory; full namespace is `parent:child` |
| `mem.close()` | Close the underlying database connection |

## Design

- **Single SQLite file**, namespaces isolate keys via `{namespace}:{key}` row IDs
- **Synchronous** (better-sqlite3) — safe in main process; renderer should go through IPC
- **JSON serialization** — round-trips objects/arrays/primitives; functions/symbols/undefined rejected at `set` time
- **`:memory:`** filename supported for tests

## Roadmap

- M1: L0 (this package) — done
- M3: L1 (essential snapshot), L2 (selective topic-relevant), L3 (deep search), encryption-at-rest
- M3+: SkillBank tier (separate package, reuses storage)
- M4: Cross-device sync via Nostr (NIP-44 encrypted)

## License

MIT
