---
"@auraaihq/core": patch
"@auraaihq/sdk": patch
"@auraaihq/cli": patch
---

Publish hygiene for M0 packages:

- Mark all 3 packages `"private": true` until they have real builds (M1)
- Declare `"engines": { "node": ">=22" }` per package (root engines doesn't propagate to published packages)
- Add `"files": ["src", "README.md", "LICENSE"]` to control publish content — dev configs (vitest.config.ts, tsconfig.build.json) are excluded from npm tarball
- Add per-package `LICENSE` (MIT)

When M1 implements real builds: flip `private: false`, change `main` to compiled `dist/index.js`, add `dist` to `files`. Until then, packages are workspace-local only.
