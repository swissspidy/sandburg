---
"sandburg": patch
---

WebAssembly threads no longer trap with "memory access out of bounds" on memory another thread just grew. V8 updates the other threads' view of a grown shared memory only lazily, and their `memory.fill`, `memory.copy` and atomic operations checked against the old size. The runtime now compiles modules with shared memory, from bytes through `new WebAssembly.Module`, `WebAssembly.compile` and `WebAssembly.instantiate`, so that such an operation refreshes the size first. Streaming compilation, modules the rewrite does not support or that are over its limits, and a guarded module that fails to compile use the original bytes. This was the intermittent rolldown trap in Vite's dependency optimizer on cold Angular runs (ADR 0070).
