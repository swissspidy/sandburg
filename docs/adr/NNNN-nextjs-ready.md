# ADR NNNN: Next.js' time to ready: source maps for the project only, server chunks compiled ahead, seeds without checks

- Status: Accepted
- Date: 2026-10-26

## Context

At the end of round 4, on this machine class (4 cores, idle; `scripts/bench.ts --modes cold,warm`,
origin/main 860c0eb), `next-app-router` took 6.3-7.0 s warm (ready 3.5-3.75 s) and 27-29 s cold
(ready 12.4 s, `Session.close` 3.3-3.7 s). A warm run is seeded: the cold run's `Session.close` waits
for the seed run, so the warm session finds the App Router seed (ADR 0037). A run gets ~8-9 s of ready
only without a seed (a session's second run while the seed run its first started is still going, or
round 1 of `--modes warm` on fresh worktrees).

Where a seeded warm run's ready goes (Next.js' own trace, `.next/dev/trace`, read from the runtime's
file system after the first page; wall-clock marks around next dev's request handler; CPU profiles and
Chromium tracing of every thread, `scripts/profile.ts`):

- `ensure-page` ~2.0 s: the server compile ~1.1 s (restoring and checking the seed's ~800 modules,
  SWC for the app's own, seal and emit), then the client's ~0.8 s (restore, the global stylesheet's
  CSS pipeline ~0.3 s), on the runtime's one thread, sequential by design (the server compile finds
  the client entries).
- `handle-request` ~0.55 s: loading the page's server chunks (`requirePage`, including fetching each
  2.5 MB vendor chunk's compiled form by digest, ~50 ms each, synchronous XHR) and the render (~0.2 s).
- The page, ~0.6 s after the HTML: the ready phase waits for the frame's `load` event, which follows
  the evaluation of the client's main chunk (`main-app.js`, 12 MB) and hydration.

**Source maps were most of the bytes.** next dev builds every module with an inline source map
(`eval-source-map`, Next.js' fork of webpack's plugin). Of `main-app.js`'s 12.0 MB, 7.4 MB were
base64 source maps, nearly all of installed modules (React DOM, Next.js' client, its dev overlay),
whose frames Next.js ignore-lists anyway. The webpack cache stores each module's source with its map:
the seed was 27 MB of gzip (78 MB inflated for the client), inflated and restored in every run.

## Decision

- **Source maps for the project's own modules only** (`SOURCE_PATCHES`, Next.js' fork of
  `EvalSourceMapDevToolPlugin`): modules under `node_modules/` are built with `useSourceMap = false`
  (SWC is not asked for a map, webpack keeps a plain source), and emitted as webpack's `eval` devtool
  emits them: `eval("<code>\n//# sourceURL=webpack-internal:///<module id>")`. Their stack frames keep
  their `webpack-internal:///…/node_modules/…` URLs, so Next.js ignore-lists them by path as before and
  `classify.ts` reads them as before. The project's modules keep their maps. `TRANSFORM_VERSION` 26.
- **The server's chunks compiled on the host as next dev writes them**
  (`node-runtime/compile-ahead.ts`): for Next.js the adapter names `.next/dev/server` and
  `.next/server`; a helper worker, started with the runtime, sends each CommonJS file the program
  writes there (one the loader would have the host lower) to the host as written: by digest first
  (`/compiled/<digest>`), else `POST /compile` with the run's compile capability, the requests the
  runtime made when it required the file. The output waits in shared memory; `hostCompile` uses it
  only for the file as it was written and unchanged since, and waits for one still compiling, but
  never for a helper that has not started (a worker the runtime starts does not start while the
  runtime blocks: a Pages Router app writes its chunks and requires them in one go).
- **Next.js seed runs have no checks of their own**: webpack stores its cache once, 5 s after the
  first page's compile; what the seed's checks compiled after it (its route handler, its second page)
  was never stored (ADR 0052), while compiling it competed with the cold app beside it.

## Consequences

- The branch against origin/main (`scripts/bench.ts --base origin/main --head 4b85feb`, both sides
  as refs, interleaved, 3 rounds, medians; all 24 runs passed; a side's `.sandburg/` carried over
  between rounds, and each round's warm run follows its cold run, so warm runs are seeded):

  | Fixture | Mode | Total | Install | Start | Ready | Checks | `Session.close` |
  |---|---|---|---|---|---|---|---|
  | next-app-router | warm | 7.04 → 5.76 s (−18%) | 0.68 → 0.57 s | 1.50 → 1.54 s | 3.75 → 2.98 s (−21%) | 1.01 → 0.74 s | |
  | next-app-router | cold | 28.96 → 26.44 s (−9%) | 4.78 → 4.98 s | 7.80 → 7.59 s | 12.49 → 10.32 s (−17%) | 1.53 → 1.18 s | 3.71 → 0.16 s (−96%) |
  | next-pages-router | warm | 4.94 → 4.27 s (−14%) | 0.56 → 0.52 s | 1.64 → 1.52 s | 1.98 → 1.61 s (−19%) | 0.58 → 0.50 s | |
  | next-pages-router | cold | 21.94 → 21.45 s (−2%) | 5.22 → 6.15 s | 7.68 → 7.39 s | 5.94 → 5.40 s (−9%) | 0.77 → 0.78 s | 1.24 → 0.42 s (−66%) |

  A cold run and its close (what a one-off `sandburg run` waits for): App Router 32.7 → 26.6 s (−19%),
  Pages Router 23.2 → 21.9 s. Cold installs move with npm (±1 s between rounds).
- **Seedless runs** (what a user meets first: installs and transforms warm, no Next.js seed yet, so
  the run compiles Next.js itself and starts the seed run beside it): origin/main 2d3bd48 against the
  branch after merging it (e88c763), each side's `.sandburg/dev-cache` removed before each run, one run
  per session, interleaved, 3 rounds, medians, all passed:

  | Fixture | Total | Ready | Checks | `Session.close` |
  |---|---|---|---|---|
  | next-app-router | 17.19 → 14.75 s (−14%) | 10.99 → 8.99 s (−18%) | 1.43 → 0.99 s | 4.03 → 1.11 s (−72%) |
  | next-pages-router | 11.72 → 10.02 s (−15%) | 5.92 → 4.86 s (−18%) | 0.74 → 0.55 s | 1.99 → 0.92 s (−54%) |

- Each change's own A/B is in its commit message: source maps, warm 6.82 → 5.74 s and cold 29.2 →
  25.0 s (n=3; the seed 27 → 9.5 MB, `main-app.js` 12.0 → 4.6 MB; the seedless run's ready 11.0 →
  9.3 s in one session); compiles ahead, warm ready 2.95 → 2.81 s, cold total unchanged (on a cold
  host, the compile it moves competes with the runtime's other requests to the host, which serve the
  first compile's files), `Session.close` 2.0 → 0.7 s; seeds without checks, `Session.close` 1.09 →
  0.43 s (n=4).
- The ten Next.js apps of `scripts/corpus` (seed 1; six App Router, four Pages Router, four with a
  seeded bug) end as before (passed, or failed as `app-bug`), in one session on each side: 96.2 →
  85.2 s in all.
- **Behaviour changes:**
  - Installed modules have no source maps in next dev: in the browser's DevTools, React's and Next.js'
    frames show the code webpack ran (SWC's output), not their original sources; the project's own
    code maps as before. The console and page errors a run records, Next.js' terminal output and its
    error overlay's frames are the same (compared on a server component and a client effect that
    throw: identical console output on both sides).
  - Next.js' seed runs no longer click, fetch or navigate in their seed project; what a seed stores
    is unchanged.
  - next dev's server chunks go to the host's compiler as they are written, not when required; a
    chunk written and never required is compiled anyway (the host's compile cache keeps it).
  - Transforms and Next.js seeds are made again once (`TRANSFORM_VERSION` 26).
- Fewer bytes per Next.js run: the seed's bundle 27 → 9.5 MB, the client's main chunk 12.0 → 4.6 MB,
  its vendor server chunks ~2.5 MB each (all three are held in the runtime's file system).

## Security

- **Source maps**: a change to how Next.js' own plugin renders installed modules, applied by the host's
  transform by path (as every `SOURCE_PATCHES` entry). What runs is the same code, without its map; a
  seed is still keyed by the versions, `NODE_VERSION` and `TRANSFORM_VERSION`, and stored only by the
  seed run (the e2e tests that an app cannot write a seed pass).
- **Compiles ahead**: no new route, socket or cache. The helper is the run's own worker, and makes the
  requests the runtime made, from the run's sandbox: `/compiled/<digest>` (the host's output for code
  it compiled before, keyed by a digest of the code) and `POST /compile` (the host's pure function of
  the code it is sent; recording a compile for the project needs the run's own token, checked as
  before). It sends only files the program wrote under the named directories, which the program could
  send itself. Its output is used only for the bytes it was compiled from.
- Tests: `test/unit/source-patches.test.ts` (the patched plugin: installed modules built without a map
  and eval'd under their URL, the project's keep theirs; fails without the patch),
  `test/runtime/files.test.ts` (files compiled as written and before they are required; a file
  rewritten before it is required compiled again and the first output unused; a file required as soon
  as written does not wait for a helper that has not started, which failed before the fix).

## What did not help

- **No source maps at all** (`devtool: 'eval'` for every compiler): ready 2.6-2.8 s against 2.8 s with
  the project's maps kept, and the seed 9.4 MB against 9.5 MB: the project's maps cost nothing
  measurable, and without them its errors would map to nothing.
- **Plain code for installed modules** (no `eval`, the plugin's own fallback): their frames became
  `main-app.js:<line>`, which Next.js does not ignore-list (more frames in its terminal output) and
  maps by reading the 4.6 MB chunk again for each frame; the browser-to-terminal error forwarding
  went missing in the run's output.
- **Prefetching the dev-cache and preload bundles in a worker** (not on the page's thread): the
  runtime waited 254-298 ms for the 9 MB seed instead of 190-270 ms. The page's thread was not the
  limit: Chromium moves ~100-130 MB/s from the host to a page here (9.5 MB in 70-110 ms, measured in
  an idle page), and a warm Next.js run moves ~63 MB as it starts (the preload bundle 24 MB, SWC's
  WebAssembly 30 MB, the seed 9 MB), all at once.
- **Compiling on the host without blocking its event loop** (esbuild's asynchronous transform for
  `POST /compile`): a 2.5 MB vendor chunk compiles in ~60 ms either way, mostly the host's own
  JavaScript (lowering each `eval` literal), and the event loop turned 7 times in that time.
- **A larger young generation** (`--js-flags=--max-semi-space-size=32`): warm ready 2.70-3.00 s
  against 2.74-2.98 s (n=4 each).

## Not done

- **The dev-cache bundle read lazily**: the runtime waits ~0.2 s at init for the seed's bundle, which
  next dev reads ~1 s later; but the preload bundle, needed at once, shares the same transfer, so the
  gain needs the transfers ordered by when they are needed (preload, SWC's WebAssembly, then the seed)
  as well as files registered before their bytes arrive. Worth ~0.1 s per warm Next.js run, and for
  Vite apps with a cache; the bundle transport is shared with the cold and runtime work.
- **Next.js' webpack cache per project** (the seed plus the project's own modules, stored after a run):
  a warm run of the same app would skip its own modules' SWC, the CSS pipeline and its route compiles
  (~0.6-0.8 s), but every run whose cache changed (the first of each app, which in a batch is the only
  one) would pay webpack's store and upload at its end.
- **next dev without its edge-server compiler** when an app has no middleware or edge routes: Next.js
  builds three compilers' configurations and compiles the edge one at start (~0.15-0.2 s); its hot
  reloader indexes the three throughout.
- **SWC's WebAssembly compiled ahead**: next dev compiles its 30 MB module synchronously at start
  (`new WebAssembly.Module`, ~60-90 ms, plus reading it); an asynchronous compile started when the
  program first loads `next` would take it off the start.
- **Seed runs without the built-in checks** (screenshot, accessibility snapshot, axe: ~0.6 s of a seed
  run's page and host, beside the cold app): `Session` would need to know a run is a seed in its checks
  phase.
