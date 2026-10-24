---
"sandburg": patch
---

Faster first installs. npm's resolution reads ahead the packuments it will ask for next (side by side, so stale cache entries are revalidated together rather than one after another), the package store unpacks each package and the WebAssembly builds and bindings are looked up as npm picks them, and a session loads npm while its browser launches.
