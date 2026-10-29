---
"sandburg": patch
---

A seed run whose dev-server cache is not stored now says why, in one line of its run's console: the cache files it waits for never came or kept changing within 40 s, reading them got no answer, they changed as they were read, the dev server failed, or the host refused the write. A seed run passes either way, and later apps then compile from scratch, so this was invisible before.
