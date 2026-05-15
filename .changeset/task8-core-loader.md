---
"@auraaihq/core": patch
---

Implement in-memory module kernel + loader (M1 phase):

- `createKernel({ memory, log?, ai?, events? })` — instantiate kernel
- `kernel.register(module)` — add to registry; refuses silent override of different instances under same id
- `kernel.load(id)` — recursive dep-first load with error capture (state: registered → loading → loaded | failed)
- `kernel.loadAll({ continueOnError? })` — topo-sorted batch load
- `kernel.unload(id)` — unloads dependents first
- `kernel.invoke(moduleId, intent)` — routes to loaded module
- `kernel.shutdown()` — unload all in reverse load order, ignores errors

Module context construction:
- Permission-gated: `ai` only when manifest declares `'ai'` permission AND kernel has an AIHandle
- `memory` only when `memory:read` and/or `memory:write` declared; read-only modules get a handle that throws on `set`/`delete`
- Per-module memory namespace via `memory.namespace(module.id)` — automatic isolation
- Logger pre-tagged with module id

Errors: `CycleError` (dep cycle), `UnknownModuleError`, `NotLoadedError` are exported.

Out of scope (later milestones, per ADR-016):
- Worker/process sandboxing (M1+ next iteration)
- npm install / disk discovery (M2)
- Signature verification + AirAccount trust (M3)

Tests: 24 unit tests covering register, load (single/dep/missing/failure/idempotent), loadAll (topo/cycle/error stop/continueOnError), invoke (routing/not-loaded/unknown), unload (reverse-dep order, no-op), memory permissions (read-write/read-only/none), shutdown (reverse load order, error tolerance). All pass.

Dependencies: peerDependencies on @auraaihq/sdk + @auraaihq/memory (workspace).
