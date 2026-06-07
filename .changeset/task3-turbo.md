---
"@auraaihq/core": patch
"@auraaihq/sdk": patch
"@auraaihq/cli": patch
---

Add turbo for monorepo task orchestration:

- Install `turbo@^2.9.6` as workspace dev dependency
- `turbo.json` defines `build`, `typecheck`, `test`, `test:coverage`, `bench`, `clean` tasks with input/output specs for incremental caching
- Root scripts now route through turbo for `build`, `typecheck`, `clean`; cached re-runs complete in milliseconds
- `pnpm test` stays on root vitest (projects mode, single process — fastest); `pnpm test:turbo` available for per-package isolated runs

This change is package-internal (no published code change), but tracked across all 3 packages for changeset completeness.
