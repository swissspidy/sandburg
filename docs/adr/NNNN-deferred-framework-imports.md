# ADR NNNN: Framework modules loaded at first use; what is left in Next.js, Angular and Nuxt runs

- Status: Accepted
- Date: 2026-10-25

## Context

After ADRs 0037, 0044 and 0045, warm runs on an idle 4-core machine (one session, the second run of a
fixture; `scripts/bench.ts`) took: next-app-router ~5.4 s, nuxt-app ~5.9 s, angular-tasks ~5.6 s,
astro-app ~4.3 s, solid-start-app ~3.9 s, sveltekit-app ~3.4 s; cold runs next-app-router ~21.6 s,
astro-app ~17 s, nuxt-app ~20.7 s. CPU profiles of every thread (`scripts/profile.ts`, warm and
`--cold`), Next.js' own trace (`.next/dev/trace`, read from the runtime's file system), per-thread
timelines and module-level inclusive times (the time a module's top-level code takes, with what it
requires) showed:

- **Eager imports of unused features.** Astro's config entry point (`astro/config`, which every
  `astro.config.mjs` imports) re-exports the svgo optimizer, which loads svgo, csso and css-tree
  (~0.13 s of a warm start, profiled); its fonts plugin imports unifont and capsize (~0.11 s); its
  Markdown processor imports the MDX compiler, whose import instantiates Sätteri's WebAssembly build
  (~0.15 s), for projects without `fonts`, `svgOptimizer` or MDX. Nuxt's dev server loads Babel for
  `@vitejs/plugin-vue-jsx` (~0.15 s; used only for .jsx/.tsx), every Nitro preset with its
  dependencies to resolve the dev one (the Azure preset's archiver, ~0.08 s), node-forge (listhen's
  HTTPS certificates) and youch (error pages).
- **Next.js, warm**: the runtime's thread is busy for the whole run. Of `ensure-page` (~1.7 s): the
  server compile ~0.95 s and the client's ~0.66 s, each mostly webpack restoring ~800 modules from the
  seed (inflating its packs, 0.38 s of the run: 16 MB to 78 MB for the client, 11 MB to 55 MB for
  the server), the app's own modules, the CSS pipeline (postcss-preset-env and friends, ~0.1 s, once per
  process); then loading the page's server bundle (~0.4 s, including ~0.2 s of the host's compile of
  webpack's `eval` chunks) and the render (~0.14 s). The route handler the checks reach compiles in
  ~0.25 s.
- **Angular, warm**: ng serve's start (~3.8 s) is the runtime's thread in TypeScript and the Angular
  compiler: `createProgram` ~1.1 s (parsing the libraries' declaration files ~0.74 s, binding ~0.29 s),
  the template and type diagnostics ~0.36 s, esbuild.
- **Nuxt, warm**: the main thread transforms modules for the Nitro worker's vite-node and for the
  client through rolldown's WebAssembly binding (~4 s of the run's ~6 s); Nitro's rollup build ~0.5 s.

## Decision

- **Deferred imports** (`src/adapters/node/deferred-imports.ts`). The host's transform
  (`transformForRuntime`) turns a listed top-level `var import_x = require("…")` of a listed module
  (esbuild's CommonJS of an ES module) into a namespace that requires the module when one of its
  properties is first read (a `Proxy`: `get`, `has`, `ownKeys`, `getOwnPropertyDescriptor`), with the
  interop wrapper (`__toESM`) deferred too; every import of the module in that file is deferred.
  Listed:
  - Astro: `assets/svg/svgo.js` (svgo), `assets/fonts/vite-plugin-fonts.js` (the unifont and capsize
    resolvers), `@astrojs/markdown-satteri/dist/processor.js` (the MDX processor);
  - Nuxt: `@vitejs/plugin-vue-jsx` (`@babel/core`, `@vue/babel-plugin-jsx`), Nitro's Azure preset
    (archiver), listhen (node-forge), Nitro's dev error handler and `@nuxt/cli`'s dev server (youch).

  Each listed module is used only inside functions (a transform, a plugin hook, an error handler) and
  has no evaluation side effect its importer relies on. `TRANSFORM_VERSION` 23.

## Consequences

- Warm and cold runs, this ADR against origin/quality-structure (`scripts/bench.ts --base
  origin/quality-structure`, both sides as refs, 3 interleaved rounds, medians):

  | Fixture | Mode | Total | Start | Ready |
  |---|---|---|---|---|
  | astro-app | warm | 4.20 -> 3.81 s (-9%) | 1.38 -> 1.13 s | 1.98 -> 1.88 s |
  | astro-app | cold | 15.93 -> 14.87 s (-7%) | 4.19 -> 3.87 s | 5.67 -> 5.48 s |
  | nuxt-app | warm | 5.61 -> 5.33 s (-5%) | 0.57 -> 0.52 s | 3.43 -> 3.10 s |
  | nuxt-app | cold | 20.59 -> 20.17 s (-2%) | 2.44 -> 2.52 s | 6.33 -> 6.21 s |
  | next-app-router | warm | 10.23 -> 10.38 s (+1%) | 1.28 -> 1.30 s | 7.29 -> 7.23 s |
  | next-app-router | cold | 22.92 -> 21.73 s (-5%) | 6.10 -> 5.71 s | 9.67 -> 8.92 s |
  | next-pages-router | warm | 5.34 -> 5.42 s (+1%) | 1.42 -> 1.35 s | 3.06 -> 3.10 s |
  | next-pages-router | cold | 15.88 -> 16.63 s (+5%) | 5.30 -> 5.49 s | 4.35 -> 4.45 s |
  | sveltekit-app | warm | 3.64 -> 3.48 s (-4%) | 1.41 -> 1.39 s | 1.02 -> 1.05 s |
  | sveltekit-app | cold | 12.36 -> 12.06 s (-2%) | 6.00 -> 5.89 s | 1.86 -> 1.84 s |
  | solid-start-app | warm | 3.95 -> 4.17 s (+6%) | 0.92 -> 0.97 s | 1.76 -> 1.75 s |
  | solid-start-app | cold | 15.36 -> 14.02 s (-9%) | 2.90 -> 2.30 s | 4.75 -> 4.46 s |
  | angular-tasks | warm | 7.74 -> 5.63 s (-27%) | 5.41 -> 3.75 s | 0.70 -> 0.54 s |
  | angular-tasks | cold | 17.26 -> 18.02 s (+4%) | 7.25 -> 7.13 s | 1.95 -> 2.00 s |

  All 84 runs passed. Only Astro and Nuxt load anything differently; the other rows are this
  machine's spread (±5%, more for cold runs, which move with npm's install) and the bench's state:
  a round's warm runs come after its cold runs, which emptied `.sandburg/`, so a warm session's first
  run rebuilds what the cold run did not leave (next-app-router's warm runs had no seed on either
  side: the seed run started beside the first run was not done when the second started; Angular's base
  median includes such a round). Next.js' seeds get new keys here (`TRANSFORM_VERSION`) on both sides
  alike.

- Each change's own A/B is in its commit message: Astro (4 rounds) warm 4.27 -> 3.98 s (-7%, start
  1.30 -> 1.06 s), cold 17.09 -> 16.26 s (-5%, start 4.60 -> 4.14 s); Nuxt (4 rounds) warm 5.60 ->
  5.39 s (-4%, ready 3.46 -> 3.28 s), cold 20.72 -> 20.82 s (within npm's spread).
- An Astro app with a Markdown page still renders it with Shiki's highlighting (Markdown goes through
  the satteri processor, not deferred); the e2e suite `vite-frameworks` passes.
- **Behaviour**: the listed modules are evaluated when first used instead of as the dev server starts:
  an app that uses svgo, Astro's fonts, MDX, Vue JSX, Nitro's Azure preset, HTTPS dev certificates or
  youch's error page loads them then (the same work, later). A preload list records only what a run
  read, so later runs of an app that does not use them do not fetch them. Transforms are made again
  once (`TRANSFORM_VERSION`), which also gives Next.js seeds new keys (seeds are made again once).
- **Security**: none of the boundaries changes. The transform is the host's own, applied to installed
  files by path (the same as `SOURCE_PATCHES`); it changes when a module's code runs, not what runs or
  where. No new route, socket or cache.

## What did not help

Measured with interleaved runs (`scripts/bench.ts`, both sides as refs).

- **A seed run that stores webpack's cache as soon as a compiler is idle**
  (`idleTimeoutForInitialStore: 0` for seed runs only): cold next-app-router 21.62 -> 21.88 s,
  `Session.close` 4.82 -> 4.80 s (3 rounds). The seed run's store is not what `Session.close` waits
  for: the seed run starts after the app's install, and its own start, compile and checks (~11 s
  together on a busy machine) end ~3.5 s after the app's; its dispose is ~0.6 s.
- **A seed with more of what apps compile**: a global stylesheet in the layout, a route handler that
  imports `NextResponse` from `next/server`, and the route handler and second page compiled before
  webpack's first store (asked for from the page's render, so that they compile within the 5 s after
  the first compile; asked for later, by the checks, they were never stored: the stored seed had no
  `api/ping` or `about/page` module). The seed then held them (`next/server`'s modules, `ua-parser`,
  css-loader's runtime), but the app's route compile went only 263 -> 247 ms: webpack's seal, chunk
  assets and emit dominate a small compile, not the modules. Requests from the render also raced the
  page's own server bundle (`__webpack_modules__[moduleId] is not a function`, a 500 for the seed's
  page); `fetch` from the runtime to localhost goes to the browser and is refused, `node:http` reaches
  the server. Dropped.
- **Deferring Next.js' MCP server and SDK, its telemetry's fetch ponyfill and SWC's download (tar)**
  (Next.js' CommonJS: `const _x = require("…")`): warm next-app-router 5.38 -> 5.43 s, start 1.12 ->
  1.15 s (4 rounds): ~50 ms of profiled time, under the noise. Dropped.
- **SolidStart, SvelteKit**: what their starts load is used: Babel compiles SolidStart's lazy routes
  and server functions every run (`@solidjs/start/dist/config/lazy.js`), and SvelteKit's build modules
  bring the Svelte compiler, which vite-plugin-svelte loads anyway.
- **A thread "blocked" on its parent**: an Angular build's JavaScript transformer (a piscina worker,
  a thread of the runtime) waited 1.7 s for its parent to answer `readFileSync('/usr/bin/ldd')`
  (napi-rs' musl probe in oxc-parser's binding) while the parent ran TypeScript. Answering that read in
  the thread: angular-tasks warm 5.39 -> 5.49 s, start 3.74 -> 3.65 s (3 rounds): the main thread
  is the critical path, not the worker.
- Two "busy" threads in profiles of Nuxt and Angular runs (rolldown's, 5-7 s in one WebAssembly
  function) are futex waits (ADR 0041), not work.

## Not done

- **Next.js' seed packs inflated off the runtime's thread by the browser**: the seed's packs are
  27 MB of gzip that the runtime inflates (0.38 s of a warm run's thread) into 133 MB. Stored
  uncompressed (the host re-encoding the seed's packs as gzip with stored blocks, which inflate at
  memory speed) and sent to the runtime with HTTP compression, the network service would inflate them
  in parallel. It moves 5x the bytes into each runtime (memory, ADR 0046) and touches the bundle
  transport (the data paths' work); ADR 0037 measured plain uncompressed packs as a wash.
- **Next.js' server chunks compiled on the host**: loading the page's server bundle includes ~0.2 s of
  round trips for the host's compile of webpack's `eval` chunks (`hostCompile`, `/compiled/<digest>`),
  the same bytes in every app with the same versions; the runtime's module loading.
- **Angular's TypeScript program**: ~1 s of every ng serve start is parsing and binding the same
  declaration files (lib, @angular/*); TypeScript has no serialized form of a parsed file to start from.
- **Nuxt's per-module transforms** for vite-node through rolldown's binding (most of its ready): Vite's
  and the WebAssembly tools' hot path (ADR 0044).
- **More deferred imports**: the mechanism takes any ES module's import by path; profiles of other
  stacks (React Router, Vue + Express, the corpus) may show more. Next.js' compiled CommonJS would need
  `const _x = require(…)` too, which nothing measured justified yet.
