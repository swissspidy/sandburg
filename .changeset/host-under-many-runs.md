---
"sandburg": patch
---

Several sessions or processes can share one `.sandburg/` safely: an install another process finished first is kept (it was replaced under its runs), egress cache entries are checked against their body's digest, and preload lists merge what other processes recorded. Installs keep their file index and dev caches their files' digests beside them, so later processes and runs read them instead of walking node_modules or parsing the cache again (less of the host's main thread per run in a batch).
