---
"sandburg": patch
---

Less WebAssembly work on the browser runtime's thread. An app's esbuild `transform` calls (esbuild 0.25 or later, as Vite 5-7 make for every TypeScript and JSX module) are answered by the host's native esbuild over the runtime's file channel, falling back to the app's own esbuild-wasm for anything else; and Vite's bundle of the project's config file is kept from the project's last run while the files it was made from are unchanged, so a warm Vite 6 start no longer runs esbuild at all.
