---
"@auraaihq/sdk": patch
---

Module interface v0.1 (per ADR-010, intentionally minimal & unstable):

- `Module` contract: `manifest`, `load(ctx)`, `unload()`, `invoke(intent, ctx)`
- `ModuleManifest`: id / version / name / description / permissions[] / dependencies[]
- `Permission` union type: `'fs:read' | 'fs:write' | 'net' | 'ai' | 'memory:read' | 'memory:write' | 'module:invoke:{id}'`
- `ModuleContext`: log, optional ai/memory handles (kernel constructs based on declared permissions)
- `Intent` (kind + payload) and `Result` (discriminated union: ok+data | ok=false+error)
- `defineModule()` helper for type inference
- Placeholder `AIHandle`, `MemoryHandle`, `Logger` interfaces (M2+ refinement when @auraaihq/ai-bridge and full kernel logger arrive)

Tests: 5 unit tests covering defineModule identity, lifecycle (load/invoke/unload), unknown intent error path, manifest immutability, Result discriminator narrowing.

This v0.1 will likely change. Treat as unstable until @auraaihq/sdk hits v1.0.
