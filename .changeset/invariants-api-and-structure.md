---
"sandburg": patch
---

Lint rules for three of the security model's invariants (cache keys are digests, the host has one server, installs never write into the package store's files), an API report that a test compares with the package's declarations, doc comments on every export and six more exported types (`RunRenderer`, `ClassifyInput`, `CompareRates`, `DockerReferenceOptions`, `SnapshotManifest`, `SnapshotRecord`). node:crypto's script bundles each package once (1.24 → 0.69 MB), and the runtime's `url.parse(…, true).query` and `url.format({ query })` follow node:querystring as in Node (the runtime's script is 7.5% smaller). session.ts and the node adapter are split into smaller modules.
