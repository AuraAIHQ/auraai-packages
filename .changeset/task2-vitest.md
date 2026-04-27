---
"@auraaihq/cli": patch
---

CLI: refactor to expose `main()` function and only auto-execute when run directly. This enables unit testing without side effects on import.
