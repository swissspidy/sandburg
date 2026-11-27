---
'sandburg': patch
---

`sandburg/browser-runtime`: a page served cross-origin isolated by its own headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) runs a project however soon it starts one. The page's installer and compiler workers wait for the service worker it registers, as its runtime does, instead of failing with "install failed: the page's installer failed: worker error" (their scripts got 404 from the page's server).
