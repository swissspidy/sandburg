---
"sandburg": patch
---

Runtimes start from compiled code: a run's spares, threads and child processes take V8's code for the runtime's script from the first runtime of the run, instead of compiling it each. The host serves `/__sandburg/node-worker.js` as a small script that imports the runtime as a module (`/__sandburg/runtime/<digest>.mjs`), which the service worker answers from Cache Storage, where Chromium keeps V8's code for it; the host page registers its service worker as it loads. A batch's renderers use ~3% less CPU and ~9% less memory at their peak.
