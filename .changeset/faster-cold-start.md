---
"sandburg": minor
---

Faster cold runs. For an install that was never run, the host transforms ahead the modules its programs will require, from the program's entry and each file the runtime asks for, and sends them as the first preload bundle. The host's install starts while the tab loads, the runtime's bundle is built while npm installs, WebAssembly builds and bindings are added side by side, and transforms of installed files are kept in memory. A Next.js app without a seed for its versions no longer waits for the seed run, which runs beside it; `Session.close` waits for a seed run in progress.
