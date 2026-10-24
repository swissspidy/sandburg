---
"sandburg": patch
---

Fixes found by a new linter (oxlint, type-aware; `npm run lint`): a batch whose directory holds a summary cut off by an earlier batch that stopped while writing it runs (it failed before it started); a preload list or compile cache on disk that does not parse counts as none instead of failing the install phase or ending the host's process with an unhandled rejection; `Readable.fromWeb` no longer reports an unhandled rejection when its web stream errors. The package also exports the `BatchRunSummary`, `ComparePair`, `SideOutcome` and `TimingStats` types, and lists `sha.js` and `process`, which the runtime imports, as dependencies.
