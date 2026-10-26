---
"sandburg": patch
---

Faster cold runs: the host rewrites the awaits of installed files (the scan and the parse check of ADR 0057) on a helper thread instead of its main thread, which the runtime waits on for its next file. The output is the same.
The host's cache writer thread is unref'd after its listeners are added, so an idle writer never holds the process open.
