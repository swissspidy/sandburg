---
"sandburg": patch
---

Faster runtime I/O: worker threads and child processes read their parent's preload bundle in shared memory; installed files come over a WebSocket to the host instead of a request each (requests from the browser context all pass through Playwright's routing); the page downloads a runtime's bundles while the worker starts, and a cold run loads files one at a time while its first bundle is predicted; UTF-16 writes, UTF-8 lengths and SHA hashing in the Node shims without byte-by-byte JavaScript loops.
