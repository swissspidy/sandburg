# ADR 0044: The slowest frameworks: waits that were timers, rolldown's builtin hooks, caches a project keeps

- Status: Accepted
- Date: 2026-10-25

## Context

After ADRs 0033-0039, warm runs of the meta-framework fixtures on an idle 4-core machine (one
session, the second and later runs; full Chromium) took: nuxt-app ~5.6 s, solid-start-app ~5.7 s,
angular-tasks ~4.3 s, astro-app ~3.7 s, sveltekit-app ~2.8 s, react-router-app ~2.0 s, against
1.2-1.5 s for vite-react-counter and lit-vite. CPU profiles of every thread (`scripts/profile.ts`,
plus a script that also records the app frame's requests, `devtools.timeline`) and a log of every
timer of 50 ms or more the runtime armed, with its stack (a temporary patch of the runtime's timers),
showed three kinds of time:

- **Waits on timers, with every thread idle.**
  - Nitro's dev server (Nuxt) holds a request that comes before its worker is ready and checks again
    every 600 ms (`DevServer.getWorker`): the first page waited ~0.5 s after the worker was ready.
  - SolidStart 2's server functions plugin loads its manifest (a virtual module the server entry and
    the client import) once no module with `"use server"` has been compiled for 1 s: every first
    page waited 1 s, and the page's hydration another second for the client's copy.
- **Per-module calls into rolldown's WebAssembly binding that did nothing.** Vite 8 runs some of
  rolldown's builtin plugins from JavaScript (`makeBuiltinPluginCallable`), which gives each every
  hook the binding has. Vite called each for every module: in a warm nuxt-app run 241 transform calls
  each to vite-json, vite-resolve and oxc-runtime (copying the module's code into the binding),
  ~1,000 resolveId calls to oxc-runtime, and loads to all of them, for hooks the plugins do not have
  (rolldown's `register_hook_usage`) or modules they leave alone. Each is ~0.1-0.3 ms to call and
  more to return through emnapi: ~0.4 s of a Nuxt or Astro run's thread.
- **Work every warm run repeats.** vite-plugin-solid compiles each `.jsx`/`.tsx` module with Babel,
  for the server and again for the client (~1.2 s of a warm SolidStart run, SolidStart's own dev
  toolbar's ~60 modules included). Nitro builds Nuxt's server with rollup in watch mode on every
  start (~0.7 s: 567 ms for the module graph, resolving, loading, transforming and parsing ~100
  modules, then every module parsed again for watch mode's cache). jiti compiles `nuxt.config.ts`
  with its Babel bundle on every start (and keeps the result in `node_modules/.cache/jiti`, which
  runs did not keep).

What the profiles showed but this does not change: most of a meta-framework's remaining time is
Vite's own per-module work (import analysis, vite-resolve's resolveId, transforms) and the runtime's
compiles of the code it loads, on the program's one busy thread; the Angular CLI's TypeScript
(~1.6 s) and esbuild (~0.6 s, Go in the runtime's thread).

## Decision

- **Source patches** (`SOURCE_PATCHES` in `src/adapters/node/install-rules.ts`; `TRANSFORM_VERSION`
  bumped, so installed copies are transformed again):
  - nitropack: `getWorker` checks every 50 ms, for as long as before (12 times the checks).
  - @solidjs/start: the server functions manifest waits 100 ms for more server functions, not 1 s.
    A module compiled later still registers its functions when it runs and has the plugin invalidate
    the manifest, as before; a call to a function no module registered is looked up by its file (the
    plugin's `server-fn-lookup`), as before.
  - @solidjs/start: the file-system router's first listing of the routes (`buildRoutes`, when the
    routes module first loads) dispatches no `reload` events. It dispatched one per route, which in
    the client reloaded the routes module 200 ms later: a hot update of app.tsx. Once runs got faster
    the page heard it in ~1 run in 20 and lost what a check had typed. Routes added, changed or
    removed later reload as before.
  - rolldown's `makeBuiltinPluginCallable`: each known builtin plugin keeps only the hooks its Rust
    source has (rolldown 1.2), with Vite's hook filters (which Vite's dev plugin container and rolldown
    both apply) no narrower than the plugin's own test: vite-json transforms `*.json`; oxc-runtime
    resolves `@oxc-project/runtime/helpers/…`, and `./…` only from one of its helpers (a guard on the
    importer, which filters cannot test), and loads `\0@oxc-project+runtime@…`; replace transforms only
    code that contains one of its keys (not when `objectGuards` adds typeof forms); vite-resolve keeps
    resolveId, watchChange, and a load for its own virtual modules (`\0vite:esm-external-builtin-require:`,
    `__vite-browser-external`, `__vite-optional-peer-dep`); the React refresh wrapper keeps resolveId
    and transform. Builtin plugins it does not know keep every hook.
  - vite-plugin-solid: looks its Babel compile up in the project's transform cache (below) before it
    compiles, and records what it compiled, unless the app passes Babel options of its own.
  - rollup: a watch Task starts from `options.cache` when it is a cache object (it always started
    empty). nitropack: `startRollupWatcher` starts from the project's last rollup cache (a file of
    the transform cache, `getFile`/`setFile`), and on `BUNDLE_END` writes the new one only if a
    module's code changed; a build that fails after starting from a cache leaves none for the next
    run. Rollup uses a cached module only if the code its load hook returns equals the cached
    original, and then reuses its transform, AST and resolutions.
- **A project's transform cache** (`src/node-runtime/transform-cache.ts`): the runtime gives dev server
  plugins a cache under `Symbol.for('sandburg.transformCache')` (not enumerable). An entry is a JSON
  file in `node_modules/.vite/sandburg-transforms/<plugin>/`, named by hashes of the module's id and
  environment and of its source, and holding the source it was compiled from; it is used only when id,
  environment and source are equal. Virtual modules (not a file in the run's file system) and sources
  over 1 MB get none. Before a run's caches are read to be kept, a run that used the cache drops the
  entries it neither used nor added. The directory is under `node_modules/.vite`, a dev-server cache
  directory (ADR 0033), so the project's next run starts from it. A plugin can also keep a file of
  its own there by name (Nitro's rollup cache).
- **jiti's cache is kept** with the dev-server caches (`node_modules/.cache/jiti` added to
  `DEV_CACHE_DIRS`): jiti names an entry by a hash of the file's source and its version.
- **A dev-server cache file written over and back again is no change** (`Vfs.track`, ADR 0036): the
  Vfs keeps, for a tracked file written over, the bytes it had before its first write since tracking
  began, and a file that ends with them is no change. The Angular CLI writes its `.tsbuildinfo` twice
  per start, ending as it was: every warm run read its 4.8 MB cache back at dispose to find it
  unchanged.
- **A hydration signal for SvelteKit** (`inputSafe` in `src/host/settle.ts`, ADR 0036): on a page
  with SvelteKit's dev script (`__sveltekit_dev`), the checks wait until an element has Svelte's dev
  `__svelte_meta`, which Svelte sets on each element in the one pass that hydrates the page. Once its
  modules were served faster, SvelteKit's requests could pause for 100 ms before it hydrated, and the
  hydration check lost its first click in 6 of 8 warm runs on one machine (1.2 s instead of 30-40 ms;
  0 of 8 on origin/main).

- **A dev script's page without a Content-Type** (`pagePort` in `src/adapters/node/process.ts`): an
  answer to the probe's GET / without a Content-Type is the page if its body starts as an HTML
  document does (doctype, `<html>`, `<head>`, `<body>` or a comment), as a browser sniffs it. A
  compound script (`a && b`) whose hand-written server sent none waited out pagePort's 60 s.

## Consequences

- The branch against origin/main, `scripts/bench.ts` (both sides refs, interleaved, 3 rounds, medians
  of the time to the result), warm:

  | Fixture | Total | Start | Ready | Checks |
  |---|---|---|---|---|
  | solid-start-app | 6.13 → 3.22 s (−48%) | 0.87 → 0.82 s | 3.39 → 1.33 s | 1.51 → 0.72 s |
  | nuxt-app | 5.68 → 4.55 s (−20%) | 0.71 → 0.53 s | 3.44 → 2.97 s | 1.10 → 0.49 s |
  | astro-app | 4.23 → 3.40 s (−20%) | 1.14 → 1.06 s | 2.26 → 1.49 s | 0.45 → 0.41 s |
  | sveltekit-app | 3.33 → 2.98 s (−10%) | 1.30 → 1.20 s | 1.14 → 0.94 s | 0.55 → 0.44 s |
  | react-router-app | 2.59 → 2.35 s (−9%) | 1.02 → 1.02 s | 0.68 → 0.48 s | 0.48 → 0.44 s |
  | angular-tasks | 4.56 → 4.39 s (−4%) | 3.09 → 2.99 s | 0.47 → 0.40 s | 0.41 → 0.41 s |
  | vite-react-counter | 1.63 → 1.59 s (−3%) | 0.72 → 0.70 s | 0.35 → 0.30 s | 0.32 → 0.34 s |
  | lit-vite | 1.22 → 1.15 s (−6%) | 0.47 → 0.48 s | 0.17 → 0.23 s | 0.24 → 0.23 s |

  All 48 runs passed. This machine ran ~10-15% slower than the one the commits' own A/Bs ran on (both
  sides). solid-start-app's install phase is 0.21 → 0.34 s for its larger dev-server cache (the
  transform cache). lit-vite's ready was 30-60 ms longer in three of four series (0.17 → 0.20-0.25 s)
  while its start was shorter; not explained (it has no route a changed hook serves differently).

  Cold (`.sandburg/` removed, npm's cache warm; install included, which moves with npm; measured at
  51c2806, before Nitro's rollup cache, the written-over cache file and SvelteKit's signal, which
  change little in a first run):

  | Fixture | Total | Start | Ready | Checks |
  |---|---|---|---|---|
  | nuxt-app | 24.27 → 19.98 s (−18%) | 2.19 → 2.16 s | 6.01 → 5.27 s | 1.11 → 0.86 s |
  | solid-start-app | 13.73 → 11.46 s (−17%) | 2.30 → 2.20 s | 4.24 → 3.01 s | 2.58 → 1.64 s |
  | astro-app | 15.93 → 13.96 s (−12%) | 4.33 → 4.30 s | 5.77 → 4.59 s | 0.42 → 0.39 s |
  | react-router-app | 9.75 → 8.90 s (−9%) | 2.36 → 2.32 s | 1.49 → 1.24 s | 0.40 → 0.40 s |
  | angular-tasks | 16.30 → 15.07 s (−7%) | 6.04 → 6.09 s | 1.76 → 1.55 s | 0.40 → 0.37 s |
  | sveltekit-app | 11.35 → 10.83 s (−5%) | 5.50 → 5.35 s | 1.57 → 1.35 s | 0.57 → 0.53 s |

  All 36 runs passed. The install phase was 2-23% shorter on the branch's side in this series, npm's
  own variance (nothing here changes installs); ready and checks are this work's. A cold SolidStart
  run's dispose is 0.03 → 0.17 s: it stores the transform cache, once.

- Each change's own A/B is in its commit message (interleaved, warm):

  | Change | Fixture | Total | Phase |
  |---|---|---|---|
  | Nitro's worker checks | nuxt-app | 5.36 → 5.09 s (−5%, n=5) | ready 3.44 → 3.10 s |
  | SolidStart's manifest | solid-start-app | 5.42 → 4.15 s (−23%, n=5) | ready 3.02 → 2.12 s, checks 1.43 → 1.02 s |
  | Transform cache (with the router fix) | solid-start-app | 4.16 → 3.19 s (−23%, n=6) | ready 2.16 → 1.47 s, checks 1.04 → 0.68 s |
  | Builtin hooks | astro-app | 3.90 → 3.22 s (−17%, n=3) | ready 2.09 → 1.64 s |
  | | nuxt-app | 4.91 → 4.52 s (−8%) | ready 2.95 → 2.60 s, checks 0.94 → 0.74 s |
  | | solid-start-app | 3.27 → 2.95 s (−10%) | start 0.75 → 0.64 s |
  | | angular-tasks | 4.15 → 3.92 s (−6%) | start 2.79 → 2.64 s |
  | | lit-vite | 1.15 → 1.02 s (−12%) | start 0.52 → 0.44 s |
  | | sveltekit-app, react-router-app, vite-react-counter | −4%, −4%, −2% | ready −13%, −13%, −29% |
  | vite-resolve's load, oxc-runtime's guard | astro-app | 3.38 → 3.09 s (−8%, n=4) | ready 1.71 → 1.46 s |
  | | nuxt-app | 4.55 → 4.45 s (−2%) | |
  | jiti's cache | nuxt-app | 4.42 → 4.28 s (−3%, n=6) | start 0.61 → 0.48 s |
  | Nitro's rollup cache | nuxt-app | 4.09 → 3.81 s (−7%, n=6) | checks 0.73 → 0.46 s; Nitro's build 703 → ~280 ms |
  | Written over and back | angular-tasks | 3.88 → 3.81 s (−2%, n=5) | dispose 0.06 → 0.01 s |
  | No Content-Type | a compound script's raw http server | start 61.4 → 0.42 s (one run each) | |
  | SvelteKit's signal | sveltekit-app | 3.92 → 3.04 s (−23%, n=5) | checks 1.47 → 0.41 s (no lost click in 10 runs) |

- The transform cache grows a SolidStart project's stored dev-server cache from 0.8 to 6.1 MB (213
  entries), and Nitro's rollup cache a Nuxt project's by 5.3 MB: mount +0.03 s and install +0.04 s in
  warm runs, already in the numbers above. Nuxt's checks gain most from Nitro's cache: Nuxt starts
  Vite's warm-up of the client entry after Nitro's build, and it is done before the page asks. The
  first run of a project compiles as before and stores the caches once.
- **Behaviour changes:**
  - A Nuxt app's first request is served up to 0.55 s sooner after Nitro's worker is ready.
  - A SolidStart app's server functions manifest lists the modules with server functions compiled
    within 100 ms of each other, where it waited for a 1 s pause; one compiled later makes the plugin
    invalidate the manifest (as one compiled after the 1 s did).
  - A SolidStart app's page no longer gets a hot update of app.tsx (`[vite] hot updated: /src/app.tsx`)
    a moment after it loads; the routes listed first no longer count as added.
  - Rolldown's builtin plugins run from JavaScript are no longer called for hooks they do not have or
    for modules their filters exclude; what they return is unchanged.
  - vite-plugin-solid's output for a module whose id, environment and source were compiled in an
    earlier run of the project comes from that run (the same output, unless a Babel plugin of the
    project's is not deterministic; an app that passes Babel options does not use the cache). A
    project's runs keep `node_modules/.vite/sandburg-transforms/` and `node_modules/.cache/jiti/`
    between them, as they keep Vite's cache.
  - Nitro's dev build of a Nuxt app reuses the modules of the project's last run whose loaded code is
    unchanged (and their resolutions), and a rollup watch given a cache starts from it.
  - `globalThis[Symbol.for('sandburg.transformCache')]` exists in the runtime.
  - A restored dev-server cache whose files end the run with the bytes they started with is not read
    back at dispose, however often they were written.
  - A dev script's server that answers GET / with an HTML document without a Content-Type is taken
    for the page at once (it was after 60 s, as the first port).
  - A SvelteKit app's functional checks start once Svelte has hydrated its page (up to 3 s), not once
    its servers have been quiet for 100 ms.

## Security

- The transform cache and jiti's cache are dev-server caches like Vite's (ADR 0033): the page writes
  them (it runs the project's code), and the host keeps and hands out a cache only under a key it
  issued to a run of the same project, a digest of every project file and the install, and only files
  under the issued directories (`cacheEntries`). One project cannot plant compiled code in another's
  run; a project can only change what its own later runs (which run its code anyway) compile to.
  Entries are used only for the exact source they hold (compared whole, not by hash), jiti only uses
  an entry whose name is the hash of the source it loads, and rollup only a cached module whose
  original code equals what its load hook returns. A plugin's file name cannot leave its directory.
- The host does not read, parse or run what the entries hold; nothing new runs on the host.
- The SvelteKit signal reads the app frame's window and elements (the same origin, as ADR 0036's
  signals): a value the app sets can only make the checks start sooner or later, within 3 s.
- The source patches change no boundary: they shorten waits, drop calls that returned nothing, and
  stop a spurious event. Rolldown's builtin plugins see the same calls that can produce output.
- Tests: `test/unit/transform-cache.test.ts` (a hit only for the same module, environment and source;
  a planted or colliding entry naming another module is a miss; virtual modules and large sources get
  no entry; unused entries pruned; a plugin's file stays in its directory), `test/unit/source-patches.test.ts`
  (each patch applies to the published code; the router's first listing dispatches nothing and later
  changes do; each builtin plugin's hooks and filters, and an unknown plugin keeps all; rollup's Task
  takes a cache object only; Nitro's watcher starts from the stored cache, writes it only when a module
  changed, and drops it after a failed build), `test/unit/vfs-track.test.ts` (written over and back is
  no change, in place or not; a new file is a change even if written twice), `test/runtime/settle.test.ts`
  (a SvelteKit page is not safe until an element has `__svelte_meta`; an app getter cannot make the
  host read more than the app's window, as before), and an e2e test in
  `test/e2e/vite-frameworks.test.ts`: a SolidStart project's cache holds its compile of src/app.tsx,
  and a copy with that file edited gets a cache of its own, with only compiles of its own source,
  while the first project's is unchanged.

## What did not help

Interleaved warm A/B unless noted:

- **Replaying the previous run's requests** (the module URLs the page asked for, sent to the dev
  server by the runtime once it listened, so that Vite transformed them while the server was otherwise
  idle): nuxt-app ready +0.5 s and checks −0.5 s, total unchanged; solid-start-app +0.9 s (n=6 each).
  Started when the page's first module request came instead: no gain for Nuxt, and SolidStart's checks
  failed (its server action URLs are GETs that change state). The program's thread was busy: there was
  little idle time to fill, and the replayed requests competed with the server render.
- **The Angular CLI's TypeScript on its own thread again** (`NG_BUILD_PARALLEL_TS=1`, which ADR 0033
  turned off): angular-tasks 4.03 → 4.09 s, start 2.63 → 2.67 s (n=4).

## Not done

- **SolidStart's and Astro's dev toolbars** (devtools overlays): SolidStart's is ~60 of the page's ~130
  modules, rendered on the server too, and its error viewer loads shiki after hydration; Astro's runs
  its audit app in the page. Turning them off from the host (`devOverlay`, Astro's `devToolbar`
  preference) would change the page's DOM and accessibility tree, and so the a11y snapshot and axe-core
  results.
- **Astro's eager imports**: `astro/dist/assets/svg/svgo.js` (svgo, csso, css-tree), the fonts code
  (unifont, capsize) and `@astrojs/telemetry` are loaded and evaluated as the dev server starts whether
  or not the project uses them (~0.1 s of a warm start).
- **esbuild-wasm off the Angular CLI's thread** (ADR 0038's): its Go code still runs on the runtime's
  thread (~0.6 s); a worker would need the runtime's file system (relative imports are resolved by Go).
- **More transform caches**: vite-plugin-solid was the one per-module compile that showed; Vue's,
  Svelte's and Astro's compilers keep state that later requests read (descriptors, the CSS of a
  component), so their compiles cannot be skipped by output alone, and Vite's own transforms (import
  analysis) record the module graph.
- **Vite's per-module cost** (import analysis, vite-resolve's resolveId through the WebAssembly binding,
  inline source maps) is most of what is left in every meta-framework; that is the runtime's and the
  wasm tools' hot path.
- **Next.js' dev-cache readback** (a lead from perf-runtime-hotpaths): a seed run's dispose reads the
  whole webpack cache back every 250 ms until it settles, base64 for every pack (~2 s of the host
  page's thread, ~0.9 s of the runtime's); binary transport and digests compared in the runtime would
  cut both. Not started for lack of time.
- `waitForRender` polls every 100 ms (`session.ts`), ~50 ms of each run's ready on average.
