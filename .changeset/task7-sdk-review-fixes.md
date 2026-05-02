---
"@auraaihq/sdk": patch
---

Review fixes for Module interface v0.1:

- `sdkVersion` is now required in `ModuleManifest` (was optional — omitting would silently disable SDK compatibility checks)
- `defineModule` now validates that `manifest.permissions` is an array (throws TypeError if not)
- `MemoryHandle.list()` adds reserved `cursor` parameter for future pagination (ignored in M1)
