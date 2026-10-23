---
"sandburg": patch
---

Faster installs: npm resolves the tree, in a worker that keeps packuments between installs, and a content-addressed store (`.sandburg/store`) unpacks each package once and hard-links it into every install, with the same files npm writes. Packages of a lockfile the install starts from, or pinned to an exact version in npm's cache, are unpacked while npm resolves; WebAssembly side installs use the same path and are kept between installs. A cold Next.js app's install phase goes from 14 s to about 6 s; installs in a batch take about half as long. The host uses more memory while installing (the resolver's worker, ~0.6 GB at its peak, which it gives back 30 s after the last install).
