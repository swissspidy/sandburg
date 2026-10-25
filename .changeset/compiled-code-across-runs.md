---
"sandburg": patch
---

Less compiling in every run: the accessibility check loads axe-core with V8's compiled code, which a session produces once and keeps in `.sandburg/code-cache` (the host also serves axe-core as `/__sandburg/axe.classic.js`, in UTF-16); the runtime's scripts are kept in `.sandburg/bundles` while what they are built from is unchanged; and the CLI enables Node's compile cache in `.sandburg/node-compile-cache`. `Session` takes `codeCacheDir` (null: none on disk).
