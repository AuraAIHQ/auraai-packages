# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mycelium Protocol 生态上下文
> 本 repo 属于 auraai 组织，参与 Mycelium Protocol 生态建设。
> 上下文来源: github.com/AAStarCommunity/Brood — 更新时自动同步

@/Users/jason/Dev/Brood/protocol/MISSION.md
@/Users/jason/Dev/Brood/orgs/auraai/PROFILE.md
@/Users/jason/Dev/Brood/orgs/auraai/INTERFACES.md

---

## Project Overview

This is a **TypeScript monorepo** containing the core SDK, libraries, and capability modules for **Agent24**, a framework for building Electron-based AI Agent clients. The monorepo powers the `@auraaihq/*` npm package ecosystem.

### Architecture

```
Agent24 (Electron AI Agent framework)
    ↓ npm file:// (dev) / npm registry (prod)
auraai-packages (this monorepo)
    ├── packages/      — Core runtime + SDK (bundled into app)
    ├── publishers/    — Pluggable capability modules
    ├── scrapers/      — Pluggable capability modules
    ├── community/     — Pluggable capability modules
    └── idoris/        — iDoris integration wrappers
```

### Core Packages

| Package | Purpose | Type |
|---------|---------|------|
| `@auraaihq/core` | Module loader, lifecycle, state machine | Runtime (bundled) |
| `@auraaihq/sdk` | Public API for module developers; types, hooks | DevDep (module dev) |
| `@auraaihq/memory` | L0 KV store (SQLite + namespaces) | Runtime (bundled) |
| `@auraaihq/ai-bridge` | Multi-adapter AI routing (fallback + priority) | Runtime (bundled) |
| `@auraaihq/cli` | Scaffolding, debugging, module packaging | Standalone tool |

### Capability Modules (Pluggable)

- `@auraaihq/publish-*` (blog, twitter, telegram) — Publishing
- `@auraaihq/scrape-*` (web, rss) — Data fetching
- `@auraaihq/module-*` (identity, wallet) — Core abilities
- `@auraaihq/idoris-*` (input, query, create) — iDoris integration

---

## Development Setup

### Prerequisites

- **Node.js**: >= 22
- **pnpm**: >= 9 (locked at `9.12.0` in `package.json`)

### Install & Build

```bash
# Install workspace dependencies
pnpm install

# Build all packages (turbo-orchestrated, cached)
pnpm build

# Type-check all packages
pnpm typecheck

# Clean build artifacts
pnpm clean
```

### Testing

```bash
# Run all tests (vitest projects mode — fastest for local dev)
pnpm test

# Watch mode
pnpm test:watch

# Coverage report (HTML + text)
pnpm test:coverage

# Turbo-orchestrated (per-package isolation + caching; good for CI)
pnpm test:turbo

# Run benchmarks
pnpm bench
```

### Single Package Development

```bash
# Build one package only
pnpm --filter @auraaihq/core build

# Test one package
cd packages/core && pnpm test
# OR
pnpm --filter @auraaihq/core test

# Typecheck one package
pnpm --filter @auraaihq/core typecheck
```

---

## Repository Structure

```
auraai-packages/
├── package.json              — Workspace root + shared scripts
├── pnpm-workspace.yaml       — Workspace globs (packages, publishers, etc.)
├── turbo.json                — Turbo task orchestration config
├── tsconfig.base.json        — Base TypeScript config
├── tsconfig.build.base.json  — TypeScript build config (test exclusions)
├── vitest.config.ts          — Root vitest config (projects mode)
│
├── packages/                 — Core + SDK (tightly coupled)
│   ├── core/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── index.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.build.json
│   │   └── vitest.config.ts
│   ├── sdk/
│   ├── cli/
│   ├── memory/
│   ├── ai-bridge/           — (placeholder, no src/ yet)
│   └── publish-blog/        — (placeholder, no src/ yet)
│
├── publishers/               — Publishing capability modules
│   ├── publish-twitter/
│   │   ├── src/
│   │   ├── package.json
│   │   └── vitest.config.ts
│   └── publish-telegram/
│
├── scrapers/                — Data fetching modules (placeholder)
├── community/               — Community modules (placeholder)
├── idoris/                  — iDoris integrations (placeholder)
│
├── cbots/                   — (external: Python bot sidecar)
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml           — TypeCheck + Test on PR/push
│   │   └── release.yml      — Publish to npm on main merge
│   └── PULL_REQUEST_TEMPLATE.md
│
├── .changeset/
│   ├── config.json          — Changeset configuration
│   └── *.md                 — Changelog entries (auto-generated)
│
└── README.md                — High-level project overview
```

---

## Build & Test Pipeline

### Local Development Workflow

1. **Typecheck**: `pnpm typecheck`
   - Turbo-orchestrated; checks packages with dependency order
   - Runs `tsc --noEmit` in each package
   - Cached per package (redoes only changed packages)

2. **Test**: `pnpm test`
   - Vitest projects mode (single process, unified output)
   - Fast startup; best for iterative dev
   - Runs `.test.ts`, `.spec.ts` files in each package

3. **Build**: `pnpm build`
   - Turbo-orchestrated (respects `^build` dependencies)
   - Outputs to `dist/` (not yet fully implemented in M0 — see package.json note)
   - Only needed when publishing; private packages skip build

### CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`):

1. **Checkout** with `fetch-depth: 2` (for changeset detection)
2. **Setup**: pnpm + Node.js 22 + turbo cache
3. **Install**: `pnpm install --frozen-lockfile`
4. **Typecheck**: `pnpm typecheck`
5. **Test**: `pnpm test:turbo` (turbo mode for caching on repeated PRs)
6. **Publish hygiene check** (PR only): verifies public packages have `dist/`, `LICENSE`, correct `main`
7. **Changeset check** (non-main branches): requires `.changeset/*.md` for source changes

### Test Discovery & Configuration

**Per-package vitest.config.ts**:
```typescript
export default defineConfig({
  test: {
    name: '@auraaihq/core',
    environment: 'node',
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    benchmark: {
      include: ['src/**/*.{bench,benchmark}.?(c|m)[jt]s?(x)'],
    },
  },
})
```

**Root vitest.config.ts**:
- Aggregates all `packages/*/vitest.config.ts` + publishers/scrapers/community/idoris
- Projects mode: each package runs independently
- Coverage provider: v8 (HTML + text reports to `coverage/`)
- **Important**: Packages must have a `vitest.config.ts` or they're silently skipped

### TypeScript Configuration

**tsconfig.base.json**:
- Target: ES2022
- Module: ESNext
- Strict mode on
- Source maps + declaration maps enabled
- `skipLibCheck: true` (faster)

**tsconfig.build.base.json**:
- Extends base
- Excludes test files: `*.test.ts`, `*.spec.ts`, `*.bench.ts`, `*.benchmark.ts`
- `noEmitOnError: true`

Each package has its own `tsconfig.json` (extends base) and `tsconfig.build.json` (extends build.base).

---

## Turbo Task Graph

**turbo.json** defines:

| Task | Dependencies | Inputs | Outputs | Cached? |
|------|-------------|--------|---------|---------|
| `build` | `^build` | `src/**`, `tsconfig*`, `package.json` | `dist/**` | Yes |
| `typecheck` | `^build` | `src/**`, `tsconfig*` | — | Yes |
| `test` | `^build` | `src/**`, `vitest.config.ts` | — | Yes |
| `test:coverage` | `^build` | `src/**` | `coverage/**` | Yes |
| `bench` | `^build` | — | — | **No** |
| `clean` | — | — | — | **No** |

**`^build` dependency**: means "only run this task after all dependencies' `build` tasks complete."

---

## Versioning & Publishing

Uses **Changesets** for independent per-package versioning and changelog management.

### Workflow

1. **Create changeset** (in PR):
   ```bash
   pnpm changeset
   # Interactive: pick packages, bump type (major/minor/patch), write summary
   # Generates .changeset/{id}.md
   ```

2. **Version** (after PR merge to main):
   ```bash
   pnpm version
   # Reads .changeset/*.md, updates version + CHANGELOG per package
   ```

3. **Release** (after version commit):
   ```bash
   pnpm release
   # Publishes packages to npm registry
   ```

**Current Status**: M0 phase. All packages marked `"private": true`. Will be opened in M1 after checklist.

---

## Key Scripts Reference

### Root Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install workspace deps |
| `pnpm build` | Build all packages (turbo) |
| `pnpm typecheck` | Typecheck all (turbo) |
| `pnpm test` | Test all (vitest projects, fast) |
| `pnpm test:turbo` | Test all (turbo orchestrated, cached) |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Coverage report |
| `pnpm bench` | Run benchmarks |
| `pnpm clean` | Clean dist/ + cache |
| `pnpm changeset` | Create changeset entry |
| `pnpm version` | Update versions from changesets |
| `pnpm release` | Publish to npm |

### Package-Specific

```bash
# Single package build
pnpm --filter @auraaihq/core build

# Single package test
pnpm --filter @auraaihq/memory test

# Single package typecheck
pnpm --filter @auraaihq/sdk typecheck
```

---

## Package Naming Convention

| Prefix | Meaning | Example |
|--------|---------|---------|
| (none) | Core, SDK, CLI | `@auraaihq/core` |
| `ai-` | AI model adapter | `@auraaihq/ai-claude` |
| `models-` | Model metadata | `@auraaihq/models-vision` |
| `module-` | Core capability | `@auraaihq/module-identity` |
| `publish-` | Publishing module | `@auraaihq/publish-twitter` |
| `scrape-` | Scraping module | `@auraaihq/scrape-rss` |
| `idoris-` | iDoris integration | `@auraaihq/idoris-query` |
| `skills-` | Claude Code skill (M3+) | `@auraaihq/skills-evolve` |

---

## Adding a New Package

1. **Create directory structure**:
   ```
   packages/new-pkg/
   ├── src/
   │   ├── index.ts
   │   └── index.test.ts
   ├── package.json
   ├── tsconfig.json
   ├── tsconfig.build.json
   ├── vitest.config.ts
   ├── README.md
   └── LICENSE
   ```

2. **package.json template**:
   ```json
   {
     "name": "@auraaihq/new-pkg",
     "version": "0.0.0",
     "private": true,
     "description": "...",
     "license": "MIT",
     "type": "module",
     "main": "src/index.ts",
     "exports": { ".": "./src/index.ts" },
     "engines": { "node": ">=22" },
     "scripts": {
       "typecheck": "tsc --noEmit",
       "build": "echo 'build TBD'",
       "test": "vitest run",
       "clean": "rm -rf dist .turbo"
     },
     "devDependencies": {
       "vitest": "^4.1.5"
     },
     "publishConfig": { "access": "public" }
   }
   ```

3. **vitest.config.ts**:
   ```typescript
   import { defineConfig } from 'vitest/config'
   export default defineConfig({
     test: {
       name: '@auraaihq/new-pkg',
       environment: 'node',
       include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
     },
   })
   ```

4. **tsconfig.json** (extends base):
   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": { "rootDir": "." },
     "include": ["src"]
   }
   ```

5. **tsconfig.build.json**:
   ```json
   {
     "extends": "../../tsconfig.build.base.json",
     "compilerOptions": { "rootDir": "." },
     "include": ["src"]
   }
   ```

6. **Add changeset**: `pnpm changeset` (when PR is ready)

---

## Troubleshooting

### Tests not running for new package

- Ensure `vitest.config.ts` exists and is in the package root
- Verify `name` field matches pattern in root `vitest.config.ts` projects glob
- Check file naming: `*.test.ts` or `*.spec.ts` (not `*.test.mts`)

### Turbo not detecting changes

```bash
# Clear turbo cache and retry
pnpm clean
pnpm build
```

### Changeset conflicts

```bash
# Verify changeset was created
ls .changeset/

# If PR didn't trigger check, ensure PR is against non-main branch
# (changeset-check only runs on non-main base)
```

### "cannot find module" errors

```bash
# Reinstall lockfile (frozen mode may be stale)
rm pnpm-lock.yaml
pnpm install
```

---

## Further Reading

- **README.md** — High-level overview + architecture diagram
- **CONTRIBUTING.md** — PR guidelines, hygiene checks
- [Agent24-Desktop docs](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs) — Architecture decisions (ADR-*, PLAN, ROADMAP)
- [Turbo docs](https://turborepo.com) — Task scheduling & caching
- [Vitest docs](https://vitest.dev) — Test framework
- [Changesets docs](https://github.com/changesets/changesets) — Versioning workflow
