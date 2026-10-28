---
"sandburg": patch
---

WebAssembly threads no longer trap with "memory access out of bounds" on memory another thread just grew. V8 updates the other threads' view of a grown shared memory only lazily, and their `memory.fill`, `memory.copy` and atomic operations checked against the old size. The runtime now compiles modules with shared memory so that such an operation refreshes the size first. This was the intermittent rolldown trap in Vite's dependency optimizer on cold Angular runs (ADR 0067).
