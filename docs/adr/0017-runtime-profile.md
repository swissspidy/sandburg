# ADR 0017: What a CPU profile of the runtime showed

- Status: Accepted
- Date: 2026-10-01

## Context

After [ADR 0016](0016-faster-batches.md), Next.js apps were most of a batch's time (13 s median,
warm). The plan was to look at browser features for speed: a code cache, threads, WebGPU, more
WebAssembly. Before choosing, we measured where the time goes.

`scripts/profile.ts` runs a project twice and records the second run with Chromium's tracing and V8's
sampling CPU profiler. That profiler sees every thread, the runtime's Web Workers included; the
DevTools profiler had timed out on the busy worker. It prints self time by package, by Sandburg's
own runtime, by WebAssembly and by GC, and the runtime's functions by self time.
`scripts/edit-loop.ts` times edits to a running app until they render.

## What the profile showed

In a warm `next dev` run of the Next.js fixture, the runtime's main thread was busy for ~12 s:

| | Self time |
|---|---|
| **Sandburg's runtime code** | **7.3 s** |
| webpack | 1.5 s |
| SWC (WebAssembly) | 0.4 s |
| JavaScript compile (parse, lazy compile) | ~2.3 s, within the above |
| GC | 0.6 s |

Most of the time was ours, not the tools'. The rest of the plan changed accordingly:

- **A code cache across runs is not available.** Each run has its own browser context, which gives
  it its own network allowlist and isolation, and contexts do not share compiled code. Within a run,
  the 2.3 s of parse and compile is small next to the runtime's own costs.
- **Parallel SWC is not worth it:** SWC is 0.4 s of 12 s.
- **WebGPU does not fit:** dev servers parse, transform and bundle code. That work is branchy and
  string-heavy, with nothing data-parallel to hand a GPU.

## Decision: the fixes the profile pointed at

1. **webpack's cache is read-only unless the run keeps it.** `next dev` gzips its cache packs as it
   stores them: 2.1 s of `CompressionStream` work in every run, for a cache only seed runs keep. A
   source patch on Next.js' `webpack-config.js` sets `cache.readonly` from
   `SANDBURG_WEBPACK_CACHE_READONLY`, which the runtime sets except in seed runs.
2. **fs callbacks run on `setImmediate`, not `setTimeout(0)`.** Browsers clamp nested timeouts to
   4 ms, and webpack's resolver chains thousands of fs calls. The worker's idle time while busy
   halved, from 1.4 s to 0.7 s.
3. **No stack traces where Node has none.** Errors of fs callback and promise calls carry no stack
   frames, as in Node. The module resolver asks the VFS what is at a path (`Vfs.kind`) instead of
   catching `ENOENT`. Building error objects went from 0.28 s to 0.07 s.
4. **Preload after 10 files, not 40,** for a program's runtime (threads keep 40). next dev's first 40
   single requests took 0.4 s.
5. **Each webpack eval module is lowered once.** next dev's server chunks are webpack eval-devtool
   output: every module is an `eval("<source>")` literal, and its async code is lowered for
   AsyncLocalStorage (ADR 0006). Lowered literals are cached by content. The final transform runs on
   a skeleton with the literals replaced by placeholders: the 6 MB vendor chunk's module code is not
   parsed again. The output is the same: every eval argument has the same value, and the code around
   them is the same.

## Measurements

Warm runs of the Next.js fixture, median of three: **11.9 s → 8.0 s** (start 3.0 → 2.6 s, ready
5.0 → 3.2 s, checks 2.3 → 1.6 s). svelte-vite: 7.2 s → 6.8 s. In the profile, Sandburg's own code
went from 7.3 s to 3.2 s. What is left of it is mostly evaluating module code (0.7 s), host compiles
(0.7 s) and synchronous file requests (0.6 s).

Edit to render, five edits in a row (`scripts/edit-loop.ts`):

| App | Edit to render | Native, same machine |
|---|---|---|
| Vite + React (HMR) | 80–90 ms each | |
| Svelte + Vite (HMR) | ~90 ms each | |
| Next.js (Fast Refresh) | first edit 1.05 s (was 1.64 s, median of three sessions), then ~0.2 s | |
| Angular 22 (`ng serve`, component update) | 1.3–1.8 s each; **~0.3 s** without `CI=1` (below) | 0.08–0.32 s rebuild |

The first Next.js edit loads a new version of the 5.9 MB vendor chunk (webpack adds its hot-reload
modules). Its host compile went from 543 ms to 98 ms. What remains is evaluating the chunk's
modules again.

Angular's per-edit cost looked like esbuild: the Angular CLI rebuilds with esbuild, which runs here as
its WebAssembly build (Go compiled to WebAssembly: one thread), ~0.9 s per rebuild. But measured
outside the browser, on the same machine and fixture, the WebAssembly build is not the problem:

| Angular rebuild after a template edit | without `CI` | with `CI=1` |
|---|---|---|
| native esbuild, Node 24 | 0.08–0.32 s | 0.32–0.58 s |
| esbuild's WebAssembly build, Node 24 | 0.15–0.36 s | 0.85–1.47 s |

Sandburg set `CI=1` for every program it ran (since the first milestone, to keep tools quiet), and
the Angular CLI turns its build cache off under CI (`cli.cache.environment: 'local'`, the default).
Without the cache, the WebAssembly build's single thread is what costs. **The runtime no longer sets
`CI`.** Programs run as on a developer's machine, which is what a dev server expects. Telemetry,
analytics prompts and update checks are turned off by their own switches instead (`DEV_ENV` in
`scripts.ts`: Next.js, Nuxt and Astro telemetry, `NG_CLI_ANALYTICS`, `DO_NOT_TRACK`,
`NO_UPDATE_NOTIFIER`). The Docker reference uses the same environment. Angular's edit to render went
from 1.3–1.8 s to ~0.3 s (0.8 s for the first edit), still on the WebAssembly build, in the browser.

Vite ≤6's first dependency pre-bundling still runs on esbuild's WebAssembly build without a cache to
help, which is the cost of a cold start, not of an edit.

## Consequences

- Next.js runs are a third faster; every stack's fs-heavy start-up gains a little.
- webpack's cache is no longer written in ordinary runs. A run that wanted to keep `.next/cache` would
  have to say so, as a seed run does.
- The Angular CLI's build cache now lives in the runtime's file system, in memory: more of the
  browser's memory per Angular run. The CLI turns its cache off on WebContainers for that reason;
  here the edit loop was worth it.
- Programs no longer see `CI`. A tool that only stays quiet under CI, with no switch of its own,
  may print or ask more; none of the fixtures does.
- Everything that runs the app stays in the browser: no step of a run depends on a native binary
  for the framework's tools. Measured against Node with the same WebAssembly build, the browser
  runtime's own overhead on an Angular rebuild is now small.
