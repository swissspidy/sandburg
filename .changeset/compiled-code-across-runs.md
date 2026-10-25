---
"sandburg": patch
---

Less compiling in every run: the accessibility check loads axe-core with V8's compiled code, which a session produces once and keeps in `.sandburg/code-cache` (the host also serves axe-core as `/__sandburg/axe.classic.js`, in UTF-16); `node:crypto` gives hashes, HMACs and random bytes from a small runtime library, `node-hash.js`, and loads crypto-browserify only when a program uses one of its other exports (a host that serves the runtime itself serves `node-hash.js` next to `node-worker.js`); the runtime's scripts are kept in `.sandburg/bundles` while what they are built from is unchanged; and the CLI enables Node's compile cache in `.sandburg/node-compile-cache`. `Session` takes `codeCacheDir` (null: none on disk).
