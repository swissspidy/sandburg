---
"sandburg": patch
---

Fixes for known bugs: a dev script whose server answers without HTML (no Content-Type, a fragment or plain text) is taken once all its processes serve a port, not after 60 s; the network check no longer fails on Chromium's own preconnects to its search engine and autofill queries, or on Next.js' check of npm's security advisories (off unless the app's next.config asks for it); a batch's memory guard keeps an allowance for an app that grows past its expected peak, for one that allocates in its checks, and for a seed run beside an app (`RunRenderer.peak()`, `RunOptions.onSeed`).
