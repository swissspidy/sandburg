---
"sandburg": patch
---

Less CPU per run: the browser raises V8's WebAssembly tiering budget, so the dev tools' WebAssembly builds (esbuild, rolldown, swc) optimize only code that keeps running, and spare runtime workers evaluate the runtime only when they are used, or woken by `node:wasi`.
