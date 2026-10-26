---
"sandburg": patch
---

Faster warm runs of async-heavy dev servers (Astro, SvelteKit): async functions in the Node.js runtime stay native, and each `await` restores AsyncLocalStorage's context itself instead of running as a lowered generator (stack traces now have Node's `at async` frames, and awaits take Node's ticks). The runtime's file helper starts before the program, so large WebAssembly binaries are no longer downloaded twice at start.
