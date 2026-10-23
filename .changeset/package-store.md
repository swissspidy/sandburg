---
"sandburg": patch
---

Faster installs: npm resolves the tree and a content-addressed store (`.sandburg/store`) unpacks each package once and hard-links it into every install, with the same files npm writes. Packages of a lockfile the install starts from, or pinned to an exact version in npm's cache, are unpacked while npm resolves, and WebAssembly side installs are kept between installs. A cold Next.js app's install phase goes from 14 s to 6 s.
