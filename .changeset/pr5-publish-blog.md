---
"@auraaihq/publish-blog": minor
---

Add `@auraaihq/publish-blog` capability module (ported from task11 branch):

- `publish` intent: POST markdown to an HTTPS endpoint, stores returned URL in memory
- `preview` intent: wraps markdown in `<pre>` with HTML escaping (XSS-safe)
- `last-url` intent: returns last published URL from memory (null when absent)
- Full `defineModule()` manifest: permissions `['memory:read', 'memory:write', 'net']`, lifecycle `on-demand`
- 17 tests covering manifest shape, all three intents, memory persistence, fetch mocking, and unknown intent guard
