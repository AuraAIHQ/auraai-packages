---
"@auraaihq/ai-bridge": patch
"@auraaihq/sdk": patch
---

Add AI Layer router (`@auraaihq/ai-bridge`):

- `Adapter` contract: `metadata` (id/name/provider/local) + `complete(prompt, options)` returning `CompleteResult`
- `AdapterError` with classified codes (`rate_limit`, `timeout`, `network`, `auth`, `invalid_request`, `context_overflow`, `unsupported`, `aborted`, `unknown`)
- `createBridge({ adapters, primary?, fallback?, policy? })` — implements sdk's `AIHandle.complete`
- Routing strategy: try primary; on retryable errors (`rate_limit`/`timeout`/`network`) fall through configured fallback chain; non-retryable errors surface immediately
- Custom `RoutingPolicy` interface — given prompt + options + available ids, return ordered adapter ids to try
- `BridgeError` with codes (`no_adapters`, `unknown_adapter`, `all_adapters_failed`, `unsupported_method`)
- `createInProcessAdapter` for tests + as a deterministic fallback (configurable text/respond callback/throwCode/latencyMs)
- `AbortSignal` propagation through bridge → adapter

SDK changes (alongside):
- `AIHandle.complete` options extended with `system` + `signal` (in addition to `maxTokens`/`temperature`) — aligns with Adapter capabilities
- Added `@types/node` dev dep + `types: ['node']` so `AbortSignal` global resolves

Tests: 25 unit tests for the bridge (createBridge validation, primary/fallback routing, retryable vs non-retryable error handling, custom policy, abort signal, introspection) + 5 for dummy adapter. All pass. Combined repo: 84 tests across 7 packages.

Concrete adapters (`@auraaihq/ai-claude`, `@auraaihq/ai-local`, etc.) ship as separate packages in subsequent tasks.
