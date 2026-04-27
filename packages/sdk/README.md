# @auraaihq/sdk

> Public SDK for module developers — exposes types, lifecycle hooks, and helpers used to build `@auraaihq/{module,publish,scrape,idoris}-*` packages.

**Status**: M0 placeholder. Module interface design begins M1 — see [ADR-010](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/decision.md#adr-010先做参考实现--渐进提取不一开始就定接口).

## Why this is a separate package from `@auraaihq/core`

Module authors only depend on this SDK, not on the kernel. The kernel imports from this package too — so types stay in sync, and module authors are insulated from internal kernel changes.

## License

MIT
