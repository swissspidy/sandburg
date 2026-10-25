---
"sandburg": patch
---

Fewer bytes between the host, the page and the runtime. Preload bundles hold the files runs read, not every file they ever loaded (a warm Next.js run's is half the size). A dev server's cache is read back and stored in binary, without base64 (a first Vite run's dispose is twice as fast). A run's install data reaches its page from the host server instead of through `page.evaluate`. `SANDBURG_TRACE_TRANSFERS=1` prints every transfer of 64 KB or more between the host, the page and the runtime.
