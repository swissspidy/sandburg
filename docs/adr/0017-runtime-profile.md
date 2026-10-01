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
| Angular 22 (`ng serve`, component update) | 1.3–1.8 s each | 0.07–0.12 s rebuild |

The first Next.js edit loads a new version of the 5.9 MB vendor chunk (webpack adds its hot-reload
modules). Its host compile went from 543 ms to 98 ms. What remains is evaluating the chunk's
modules again.

Angular's per-edit cost is esbuild: the Angular CLI rebuilds with esbuild, which runs here as its
WebAssembly build. That build is Go compiled to WebAssembly: one thread, and every file system call
crosses into JavaScript. It takes ~0.9 s per rebuild where native esbuild takes under 0.1 s. Vite ≤6's
first dependency pre-bundling is the same cost at a larger scale.

## Consequences

- Next.js runs are a third faster; every stack's fs-heavy start-up gains a little.
- webpack's cache is no longer written in ordinary runs. A run that wanted to keep `.next/cache` would
  have to say so, as a seed run does.
- The largest remaining gap to native is esbuild's WebAssembly build: Angular rebuilds and Vite ≤6's
  first pre-bundling. Closing it means a native esbuild for the browser runtime, speaking the same
  service protocol the WebAssembly build speaks. That is a project of its own: plugins run in the
  browser, and esbuild must read the runtime's files, not the host's.
