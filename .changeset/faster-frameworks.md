---
"sandburg": minor
---

Faster runs of meta-framework apps (SvelteKit, Astro, Nuxt, SolidStart, React Router, Angular), warm ones above all. A run keeps its dev server's whole cache for the next run of the project (`node_modules/.vite` with SSR and plugin metadata, Nuxt's `node_modules/.cache/vite`, the Angular CLI's `.angular/cache`), sent to the runtime as a bundle, and the host keeps what it compiled for the project's runtimes (Vite's SSR modules) for its next run. The browser runtime starts `react-router dev` with `--conditions=development` (instead of relaunching it), `nuxt dev` with `--no-fork`, the Angular CLI with `NG_BUILD_PARALLEL_TS=0`, and napi-rs WebAssembly packages with one async worker (`NAPI_RS_ASYNC_WORK_POOL_SIZE=1`). The runtime takes node options (`execArgv`) for the program it starts.
