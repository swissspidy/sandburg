# ADR 0046: Memory accounting: each app's renderer, measured

- Status: Accepted
- Date: 2026-10-25

## Context

ADR 0039's memory guard opens a batch's next app only with 1.5 GB available, and counts an app that
just opened as 1 GiB used for 10 s or until its checks, because its memory does not show in
`availableMemory()` yet. The review of that change called the 10 s a heuristic. This round measured
when apps allocate, and what a renderer holds, on a 4-core machine with 15 GB.

- **When a renderer allocates.** Each run's renderer, sampled from `/proc` every 200 ms (one app at a
  time; a fresh session's first run is cold, its second warm), holds 40-60 MB (the host page) from
  when its tab opens through mount and install, and grows from the start phase on:

  | Fixture | Cold: start at | Cold: at checks / peak | Warm: at start / ready / checks / peak |
  |---|---|---|---|
  | `vite-react-counter` | 25.9 s | 327 / 364 MB | 109 / 257 / 331 / 339 MB |
  | `next-app-router` | 22.2 s | 862 / 953 MB | 150 / 387 / 925 / 1,365 MB (with its seed run's) |
  | `astro-app` | 15.6 s | 609 / 632 MB | 78 / 412 / 578 / 578 MB |
  | `angular-tasks` | 27.4 s | 998 / 1,069 MB | 100 / 750 / 790 / 827 MB |

  So on a cold install the 10 s ran out long before the app allocated anything (a cold Next.js app
  reached 953 MB 46 s after it opened), and on a warm run the guard counted 1 GiB on top of what had
  already shown. A cold Next.js run's seed run (ADR 0037) had a renderer of its own, up to 1.4 GB,
  beside the app's.
- **What a renderer holds.** Per isolate (DevTools, `Runtime.getHeapUsage`, with the page's workers
  and theirs), at a warm run's checks: `vite-react-counter` (305 MB) has 12 isolates, 81 MB of
  JavaScript heaps and 74 MB of array buffers; the program's runtime 32 MB of heap, eight idle spare
  runtimes 1-7 MB each. `next-app-router` (984 MB): its runtime 332 MB of heap (236 MB used) and
  199 MB of buffers, the page 49 + 36 MB, the service worker 26 MB of buffers, a helper worker 57 MB.
  The rest of a renderer's anonymous memory is V8's and Blink's own (code, partition allocator) per
  isolate. A heap snapshot of that runtime (at its checks; the snapshot's GC left 145 MB of its
  236 MB): array buffers 301 MB (the shared preload bundle 64 MB; the VFS's large files 76 MB, among
  them `next/wasm/@next/swc-wasm-nodejs/wasm_bg.wasm`, 29 MB, beside its compiled module's 33 MB;
  webpack's cached sources 52 MB), strings 97 MB, code 21 MB.
- **Garbage.** A full collection in each of a run's isolates, 2 s into a warm run's checks: renderer
  `next-app-router` 987 → 637 MB, `astro-app` 610 → 356 MB, `angular-tasks` 725 → 508 MB,
  `vite-react-counter` 330 → 224 MB. An app in its checks is done compiling; V8 collects its
  workers' old generations late.

## Decision

- **Each run finds its renderer** (`orchestrator/renderer-memory.ts`; inside Chromium's OS sandbox,
  by other means: ADR 0061). Chromium's DevTools Protocol
  does not name a page's process, but gives the CPU time of both: the page's (`Performance.getMetrics`,
  ProcessTime, measured in the renderer) and each renderer's by pid (`SystemInfo.getProcessInfo`,
  from the browser process). The renderers' times are read just before and just after the page's:
  the page's renderer had at most the page's time before and at least it after (give or take a
  clock tick), so each renderer is held to what it used itself in between; when two fit (tabs that
  loaded side by side) it looks again 250 ms later. (A first version allowed any renderer the wall
  time between the readings times the cores: with eight tabs busy, one run in ten ended before its
  renderer was found.) It starts
  looking at the start phase (before that the renderer holds the host page only, and looking during
  mount and install cost those phases ~0.07 s), then reads the renderer's resident anonymous and
  shared memory (`/proc/<pid>/status`, RssAnon + RssShmem) once a second for its peak. Linux only.
- **RunResult.memory.rendererPeakBytes** (new, optional in the schema), and batch summaries record it
  per run (`rendererPeakBytes`).
- **The guard counts what each open app has yet to allocate** (`outstanding` in `batch.ts`): until
  its checks, its expected peak less what its renderer holds now; in its checks, nothing more (it
  adds 5-10% of its peak then, which the reserve covers). Expected peak: its project's in the latest
  20 batches' summaries × 1.1 (capped at 4 GiB), else 1 GiB. Where the renderer cannot be read, the
  whole expected peak until its checks. No time window.
- **A batch short of memory has its apps in their checks collect garbage** before it waits, at most
  every 10 s each, and does not wait for them (`orchestrator/collect-garbage.ts`: the run's tab's
  DevTools session, `HeapProfiler.collectGarbage` in the page, then in each target it auto-attaches,
  unflattened, through `Target.sendMessageToTarget`; each given 2 s, as a WebAssembly thread blocked
  in `Atomics.wait` answers nothing). The run hands its renderer to the batch as
  `RunOptions.onRenderer({ used, collectGarbage })`.
- **The runtime's file system holds large installed files weakly once read** (`Vfs.read`): an
  installed file of 4 MB or more is kept through a `WeakRef`; once its reader lets go (`readFileSync`
  copies) and a GC collects it, a later read fetches it again from the host, which serves it the
  same. Smaller installed files, and every file the program writes, are kept as before.

## Consequences

- The branch against origin/main (`scripts/bench-batch.ts` and `scripts/bench.ts`, both sides as
  refs, interleaved, medians):

  | Measured | Base | Head | Change |
  |---|---|---|---|
  | 24 corpus apps, warm, `parallel` 4, in a 4.5 GB memory cgroup (n=3): wall | 58.26 s | 50.15 s | −14% |
  | the same: machine CPU | 74% | 87% | |
  | the same: peak renderers | 2,117 MB | 2,390 MB | +13% |
  | 24 corpus apps, warm, `parallel` 4, no limit (15 GB, n=3): wall | 41.48 s | 42.18 s | +2% |
  | the same: peak renderers | 4,202 MB | 4,103 MB | −2% |
  | 12 corpus apps (seed 2), cold, `parallel` 4, in the cgroup (n=2): wall | 120.6 s | 121.6 s | +1% |
  | the same: peak renderers | 2,180 MB | 1,964 MB | −10% |
  | `vite-react-counter`, one warm run (n=5) | 2.05 s | 2.02 s | −1% |
  | `lit-vite`, one warm run (n=5) | 1.51 s | 1.47 s | −3% |
  | `next-app-router`, one warm run (n=5) | 5.66 s | 5.62 s | −1% |

  In the cgroup the branch was faster in every round (base 67.5, 57.5, 58.3 s; head 58.3, 50.2,
  49.1 s), with the same 16/24 passing: it opens more apps
  in the same memory, because what already shows counts once and the apps in their checks give back
  their garbage. Without a limit the guard does not bind; the 2% (base 41.4-42.5 s, head 42.1-42.2 s)
  is within a batch's noise here, and the host's and browser process's CPU rose 3% (the DevTools
  calls that find each renderer). Each side's `.sandburg/` carried over between rounds after one
  warm-up batch, so the branch had peaks in its summaries. **The OOM killer**: in these runs the
  cgroup killed one process, a renderer of 674 MB, 71 s into the warm-up batch of origin/main's side
  (cold: its apps installing, the 10 s windows long over); none on the branch's side.
  A long session (30 warm `vite-react-counter` runs, a collection at each checks, a GC of the host
  every 5): the host's heap 53-58 MB, its RSS 232-271 MB, no growth.

- Each change's own measurement is in its commit message (each against the commit before it): the
  guard on the renderers, in the
  cgroup, 60.82 → 55.92 s (−8%, n=3), 43.77 → 44.36 s without it (n=3), cold in the cgroup 121.3 →
  125.4 s (+3%, n=2: installs now hold their allowance); garbage collected when short, in the
  cgroup, 54.06 → 51.72 s (−4%, n=3); large installed files, a warm `next-app-router` renderer's
  peak 1,013 → 972 MB (n=4), the others unchanged.
- **Behaviour changes**: `RunResult.memory` (Linux, in-browser runs); `BatchRunSummary.rendererPeakBytes`;
  `RunOptions.onRenderer`; a batch's guard holds a cold app's allowance through its install, and
  counts what shows of a warm one once; a batch short of memory pauses its apps in their checks for
  a collection (0.1-0.8 s of their runtimes' threads); the runtime fetches a large installed file
  again if read after it was collected. The memory measurement uses one DevTools session per run's
  page for a moment (detached once its renderer is found) and the browser's own session.

## Security

No boundary changes: each run keeps its own browser context, origin and renderer; nothing new is
shared between runs.

- The renderer's pid comes from Chromium's own reports, and its memory from `/proc`, both read by
  the host; no page sees them. An app can change its own renderer's CPU time, but its own renderer
  always fits its reading, so at most it makes two renderers fit (none is taken: the app counts as
  its whole expected peak). A wrong or missing match changes only when the next app opens.
- The garbage collection goes through the run's own tab's DevTools session, to its page and the
  targets it auto-attaches (its workers and service worker); another sandbox's page is not
  reachable from it. It runs only DevTools' collection, and auto-attach is set back off after; the
  app has no API or global for it and sees only the pause. Each target has 2 s, so a blocked worker
  cannot hold the host.
- A summary's `rendererPeakBytes` (the user's own batch directory) can only delay the next app, at
  most as an app of 4.4 GiB would; with no app open the next always opens. A test writes a
  tampered one.
- An installed file fetched again comes from the same content-addressed install (`installKey`) over
  the same channel as its first read; files the program wrote are never dropped.

## What did not help

- **V8's memory saver mode** (`--js-flags=--memory-saver-mode`, for every renderer): warm
  `next-app-router` renderer 987 → 774 MB but 5.9 → 6.6-7.2 s; `vite-react-counter` 317 → 276 MB at
  the same time (n=3). In a batch in the 4.5 GB cgroup, peak renderers −14% but renderer CPU +31%
  and wall 59.39 → 66.21 s (+11%, n=2).
- **A smaller young generation** (`--max-semi-space-size=4`): `next-app-router` −5% renderer memory,
  `vite-react-counter` unchanged, times unchanged (n=3): not worth a flag on every isolate.
- **Looking for the renderer from the tab's start**: mount + install +0.07 s on a warm Vite run
  (n=5); from the start phase on, the phases were as fast as before (n=7).
- Chromium tracing to name each frame's process (`TracingStartedInBrowser`): 70-400 ms a trace, and
  it starts a tracing service process.

## Not done

- **Collecting garbage at every app's checks**, not only when short: a batch with memory to spare
  would gain nothing for the CPU (0.1-0.8 s a run).
- **Idle spare runtimes after an app is ready**: a warm Vite run keeps eight (1-7 MB of heap each,
  plus each worker's fixed cost). A program can still start a thread while blocked, which needs one:
  releasing them is perf-runtime-hotpaths' to weigh.
- **Seed runs in the guard**: a cold Next.js run's seed run (its own renderer, up to 1.4 GB) is not
  an app of the batch; a batch's warm-up (`prewarm`) runs seeds first, but a stack it did not warm
  seeds beside the batch's apps.
- **The VFS's copies of the dev server's output** (`main-app.js` 11.5 MB, `vendor-chunks/next.js`
  8 MB) and webpack's cache packs restored from the dev-cache bundle (`1.pack.gz` 15 MB), which
  webpack also holds deserialized.
