---
"sandburg": patch
---

Faster cold runs: a runtime's compiles (Vite's server modules, project files) go over its file channel instead of a synchronous request each, the file channel takes WebSocket messages that the browser sends in fragments (larger requests no longer close it), installed files of 1 MB or more are fetched over HTTP at once, and the host writes its transform and compile caches from a worker thread.
