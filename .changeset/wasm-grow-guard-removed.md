---
"sandburg": patch
---

WebAssembly modules with a shared memory (rolldown's, oxc-parser's and Tailwind's oxide WebAssembly builds) are compiled as they are again: Chromium 157 and later fixed the V8 race the runtime guarded against, and Playwright's Chromium is newer, so runs that compile them start sooner (about 0.1 s for rolldown). A Chromium older than 157 given with `SANDBURG_CHROMIUM` or `executablePath` gets a warning, as WebAssembly threads in it can trap with "memory access out of bounds".
