---
"sandburg": patch
---

Faster Next.js runs: next dev keeps source maps for the project's own modules only (installed modules keep their `webpack-internal:///` stack frames, without a map), the server's chunks are compiled on the host as next dev writes them, and Next.js seed runs have no checks of their own.
