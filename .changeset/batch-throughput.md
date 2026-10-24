---
"sandburg": minor
---

Faster batches that use less memory. A batch starts its projects in the order earlier batches suggest (the summaries in its batch directory): new projects first, then those whose checks waited longest, then those that ran longest, so that the apps that keep a batch open no longer start last (results stay in the order given; `longestFirst: false` keeps the order). Before it opens another app, a batch checks that the machine (or the process's memory cgroup) has 1.5 GB available, and waits for an app to end when it has not (`memoryReserve`). `--parallel` and `runBatch` default to one app per core, up to 8, instead of 4. Batch summaries record each run's `checksMs`. The threads of a napi-rs WebAssembly build (rolldown's, in every Vite 8 app) no longer boot spare runtimes of their own: a Vite 8 run's renderer holds 12 fewer idle runtimes (~90 MB). The host's compiles in memory are bounded by their size (128 M characters) instead of their count.
