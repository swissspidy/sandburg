---
"sandburg": patch
---

The browser install (`--install-in browser`) runs in a worker of its own instead of on the host page's main thread: resolving the tree, unpacking the tarballs, the source patches and copying node_modules into shared memory no longer block the page on large dependency trees.
