# @auraaihq/core

> Kernel for Agent24-Desktop. Hosts the module loader, IPC bridge, AI Layer adapter framework, Memory Layer integration, and Conversation Layer.

**Status**: M0 placeholder. Implementation begins M1 — see [ROADMAP](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/ROADMAP.md).

## What this is

This is the always-loaded kernel of Agent24-Desktop. It is **not** a capability module — it is the substrate that loads modules. Capability modules (`@auraaihq/module-*`, `@auraaihq/publish-*`, etc.) call into this package to access AI, memory, IPC, and to register their capabilities with the dispatcher.

## Responsibilities

- **Module loader / lifecycle** — discover, install, load, unload, reload `@auraaihq/*` modules
- **IPC bridge** — main↔renderer messaging with permission gating
- **AI Layer adapters** — abstract AI provider interface; route calls between iDoris / Claude / OpenAI / local
- **Memory Layer integration** — expose `@auraaihq/memory` to modules
- **Conversation Layer** — task decomposition + scheduling primitives
- **Sandboxing + permissions** — module privilege boundaries

## What's NOT here

- Concrete AI providers → `@auraaihq/ai-*`
- Memory implementation → `@auraaihq/memory`
- Modules → `@auraaihq/{module,publish,scrape,idoris}-*`
- Electron shell + UI → `Agent24-Desktop` repo

## License

MIT
