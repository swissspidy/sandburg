---
"sandburg": patch
---

Faster runs around the app: a session keeps the next run's tab ready (its context, host page and runtime loaded ahead of the run; `spareTab: false` turns it off), the checks load axe-core and the page checks' runtime off the main thread while the screenshot and accessibility snapshot are taken side by side, ready asks the host page whether the app rendered, a Vite app's own dependency cache reaches the runtime as a bundle, and batches start the next app when one reaches its checks (at most twice `parallel` open).
