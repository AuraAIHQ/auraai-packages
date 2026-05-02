---
"@auraaihq/publish-blog": patch
---

Review fixes for publish-blog module:

- `package.json`: add `engines: { "node": ">=22" }` and `"clean": "rm -rf dist .turbo"` for consistency with other packages
- `package.json`: `"license"` updated to `"Apache-2.0"` to match repo-wide compliance (PR #8)
- Endpoint validation now uses `new URL(endpoint)` to catch malformed URLs (e.g. `"https://"` with empty host) rather than just checking `startsWith('https://')`
- `escapeHtml` comment clarifies it is safe only in `<pre>` content, not attribute contexts
