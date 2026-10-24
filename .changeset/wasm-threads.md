---
"sandburg": patch
---

Faster runs of apps whose dev servers run WebAssembly threads (Vite 8's rolldown, Astro's compiler, the other napi-rs builds): a napi-rs build's threads no longer boot spare runtimes of their own, threads tell node_modules paths the install does not have without asking their parent, and the runtime of a Vite-based, Angular or multi-package app starts its spare runtimes as the run mounts, so that they are ready when its program starts threads. Spares load a stub, `/__sandburg/node-spare.js`, until they are used (a host that serves the runtime itself serves it next to `node-worker.js`), and a woken process keeps two of them evaluated ahead instead of all.
