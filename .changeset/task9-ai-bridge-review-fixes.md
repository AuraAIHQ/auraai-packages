---
"@auraaihq/ai-bridge": patch
---

Review fixes for AI bridge:

- `BridgeErrorCode` is now imported from `@auraaihq/sdk` (canonical source) and re-exported; local duplicate definition removed
- `createBridge` accepts an optional `log` parameter (`{ warn(msg: string): void }`) so warnings from `sanitizeUsage` are injectable instead of going to `console.warn` — pass a spy in tests to assert on or suppress bridge warnings
- JSDoc on `createBridge` documents the `semaphoreRegistry` test-isolation requirement
