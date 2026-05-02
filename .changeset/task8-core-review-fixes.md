---
"@auraaihq/core": patch
---

Review fixes for in-memory kernel:

- `list()` now returns a shallow snapshot (`new Map(records)`) instead of exposing the internal mutable Map via double type assertion
- `invoke()` now throws immediately when the kernel is shutting down (consistent with `register`, `load`, `loadAll`)
- `isSdkVersionCompatible` now requires exactly 3 dot-separated numeric segments (rejects malformed strings like `"0.1.evil"`)
- Comment clarifying that unknown permissions generate warnings in M1, not errors — rejection enforcement is deferred to M2
