---
"@auraaihq/memory": patch
---

Implement L0 (key-value, namespace-scoped, sqlite-backed) memory layer:

- `createMemory({ filename, namespace? })` — open or create SQLite store (`:memory:` for tests)
- `get<T>(key)`, `set(key, value)`, `delete(key)` — basic CRUD with JSON serialization
- `list(prefix?)` — list keys in current namespace, optionally filtered (LIKE-escaped to handle `%`, `_`, `\` literally)
- `namespace(child)` — derive isolated child memory; nesting composes via `:` separator
- `close()` — owner-only close; child memories share the parent connection

Storage: `memory_kv (ns_key TEXT PRIMARY KEY, value TEXT)` WITHOUT ROWID for fast prefix scans. WAL journal mode + NORMAL synchronous for safe concurrent reads in single-process usage.

Validation: rejects empty keys, namespaces containing `:`, and non-JSON values (functions/symbols/undefined) at set time. 30 unit tests cover get/set/delete, validation, list with prefix + LIKE-escape, namespace isolation + nesting + close-isolation, options validation.

L1-L3 + SkillBank arrive in M3.
