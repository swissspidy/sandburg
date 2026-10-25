---
"sandburg": minor
---

A batch's memory guard now measures each open app's renderer instead of counting a just-opened app as 1 GiB for 10 s: an app counts as what it has yet to allocate, its expected peak (its project's peak in the latest batches, or 1 GiB before its checks) less what its renderer holds now, so an app whose install outlasts 10 s is still counted, and memory that already shows is not counted twice. Each in-browser run on Linux reports its renderer's peak memory (`RunResult.memory.rendererPeakBytes`), and batch summaries record it per run (`rendererPeakBytes`). Large installed files (4 MB or more, such as a WebAssembly binary) are no longer kept in the runtime's memory after they are read; a later read fetches them again.
