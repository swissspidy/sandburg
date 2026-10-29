---
"sandburg": patch
---

`sandburg batch --no-longest-first` starts the projects in the order found, instead of those that took longest in earlier batches first, so that two batches' per-app times can be compared (`longestFirst: false` in `runBatch`).
