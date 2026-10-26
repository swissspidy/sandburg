---
"sandburg": patch
---

A large installed file downloaded on the side (a WebAssembly binary) is now downloaded once when the program reads it before the runtime's file helper has started, as on a loaded machine: the runtime takes the file itself, and the helper skips its queued download.
