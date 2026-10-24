---
"sandburg": patch
---

Faster Next.js runs. A Pages Router app (no `app/` directory) starts from a webpack seed of its own, run once per set of versions as the App Router's is (it found none of its modules in the App Router's seed); TypeScript 7's `tsc --showConfig`, which next dev waits for as it starts, exits as soon as it has printed (installs are made again once); and the seed run uploads webpack's cache as a Blob and polls for it every 250 ms, so `Session.close` waits less for it.
