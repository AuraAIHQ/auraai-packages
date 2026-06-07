---
"@auraaihq/boxlite-client": minor
---

Add `@auraaihq/boxlite-client` package — BoxLite OCI container client (extracted from Agent24):

- `service.ts` — `startService / stopService / stopAll / getHostPort / isRegistered / proxyToService`: manages long-running OCI containers via SimpleBox with port-forwarding, health checks, and concurrent-start dedup
- `host.ts` — `runPython / isBoxliteAvailable / getBoxliteError`: sandboxed Python runner via CodeBox with graceful degradation when native binding is absent
- Imports `ContainerConfig` from `@auraaihq/sdk` (no redefinition)
- `@boxlite-ai/boxlite` is an optional peer dependency — package degrades gracefully on unsupported hardware
- Test helpers `__resetForTest / __injectEntryForTest / __resetHostForTest` for isolated unit tests
- 26 tests: no-binding path, fake CodeBox, fake SimpleBox lifecycle, concurrent dedup, stop/stopAll, proxy GET/POST/query/headers
