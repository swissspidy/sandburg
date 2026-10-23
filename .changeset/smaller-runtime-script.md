---
"sandburg": patch
---

Less to compile per runtime worker: the runtime's script is 0.86 MB instead of 2.8 MB. The polyfills of `node:crypto`, `node:zlib` and `node:wasi` are scripts of their own (`/__sandburg/node-crypto.js`, `node-zlib.js`, `node-wasi.js`), loaded the first time a program requires the built-in, and `node:wasi` no longer brings emnapi. Every thread and spare runtime compiles and starts faster, and a run's renderer uses less memory. A page that serves the runtime itself must serve these scripts next to `node-worker.js`.
