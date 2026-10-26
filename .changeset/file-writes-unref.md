---
"sandburg": patch
---

The host's cache writer thread is unref'd after its listeners are added, so an idle writer can never hold the process open.
