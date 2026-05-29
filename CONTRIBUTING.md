# Contributing to auraai-packages

## Adding a New Package

Every new package under `packages/`, `community/`, `publishers/`, `scrapers/`, or `idoris/` **must** include a `vitest.config.ts` file.

The root vitest config auto-discovers packages via glob patterns such as:

```
packages/*/vitest.config.{ts,js,mjs}
community/*/vitest.config.{ts,js,mjs}
...
```

Without a `vitest.config.ts`, the package is silently excluded from `pnpm test` (root vitest projects mode) **and** from `pnpm test:turbo` (turbo-orchestrated per-package runs). Tests will never run in CI.

### Minimal vitest.config.ts

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

Add coverage thresholds if your package has meaningful logic:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
```

## Build

Each package must export compiled output from `dist/`. The root `turbo.json` orchestrates `build` → `typecheck` → `test` in dependency order. Run `pnpm build` from the root to build all packages incrementally.

## Changesets

Use [changesets](https://github.com/changesets/changesets) for version bumps:

```bash
pnpm changeset        # describe what changed and which packages are affected
# commit the generated .changeset/*.md file in your PR
```
