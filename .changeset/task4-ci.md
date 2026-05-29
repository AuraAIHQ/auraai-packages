---
"@auraaihq/core": patch
"@auraaihq/sdk": patch
"@auraaihq/cli": patch
---

Add GitHub Actions CI:

- `.github/workflows/ci.yml` — typecheck + test on every PR/push, with turbo cache reuse, publish-hygiene check (private packages skip; public must have dist/, main pointing to dist/, LICENSE), changeset-present check
- `.github/workflows/release.yml` — on main push, runs changesets/action to create version PR or publish; supports npm provenance via OIDC
- `.github/PULL_REQUEST_TEMPLATE.md` — summary/changes/test plan checklist
- `.github/dependabot.yml` — weekly npm grouped updates (typescript/vitest/changesets/turbo) + monthly actions

CI gates: PR cannot merge to milestone branches without typecheck pass, tests pass, publish hygiene ok, and a changeset present (when source files changed).
