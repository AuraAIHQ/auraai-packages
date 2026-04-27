---
"@auraaihq/cli": patch
---

CLI placeholder simplification: remove `bin` field and shebang; CLI is now library-only for M0 (no .ts-as-bin runtime hazard). Real CLI binary with proper compile pipeline arrives in M1. Existing `main()` export remains for testing and future internal callers.
