# ADR 0039: Batch throughput and memory

- Status: Accepted
- Date: 2026-10-24

## Context

ADR 0031 let a batch start its next app when one reaches its checks (at most twice `parallel` open).
This round measured whole batches, warm, on a 4-core machine with 15 GB: 12 and 24 apps from
`scripts/corpus` (seed 1: a third each Vite 6 + React, Next.js 15, Vite 6; a third of them with a
seeded fault, so 16 of 24 pass), and the ten Vite 8 fixtures. A new harness,
`scripts/bench-batch.ts`, A/Bs two revisions as `scripts/bench.ts` does and samples every process of
the batch from `/proc` every 500 ms: the PSS of the host's processes and of Chromium's (renderers
apart), CPU seconds by process kind, the machine's CPU use over time, and the host's event loop.

- **Throughput stops at about one app per core.** 24 apps (3 rounds): 44.4 s at `parallel` 3,
  43.2 s at 4; in one round with two identical sides, 41.9 and 43.4 s at 4 against 41.4 and 41.1 s
  at 6, with peak renderers 4.0 GB at 4 and 5.3 GB at 6. On 2 cores (`taskset`, 12 apps, 2 rounds):
  40.0 s at 2, 41.6 s at 4, with 2.0 and 3.7 GB of renderers. The CLI's default was 4 on any
  machine.
- **The cores are busy until the tail.** CPU time of a 24-app batch at 4: renderers 95 s, the host's
  process 12 s, Chromium's browser process 11 s, its network service 3 s, GPU process 2 s. The
  host's main thread was busy 25% of the time (a CPU profile: Playwright 2.3 s, GC 1.3 s, file
  system calls; event loop delay p99 ~40 ms): not the bottleneck. The machine's CPU use was 95-99%
  until ~30 s, then 52, 29, 8, 3% to the end at ~42 s: the last apps to start were waiting in
  failing assertions (5-15 s each) with nothing left to run beside them.
- **Memory follows the open apps.** A Next.js run's renderer peaks at ~1 GB, a Vite run's at
  0.3-0.8 GB; a batch at 4 holds up to 8 open. Nothing checked whether the machine had the memory for
  the next one: a batch that runs out loses the browser, and every open app with it, to the
  out-of-memory killer.
- **What a renderer holds.** Reading each isolate's heap over the Chrome DevTools Protocol
  (auto-attaching to the page's workers and theirs, unflattened, `Runtime.getHeapUsage`): a warm
  `next-app-router` run's renderer (956 MB) is mostly its program's runtime, 234 MB of JavaScript
  heap (336 MB reserved) and 199 MB of array buffers; the host page holds 41 MB of heap and 36 MB of
  buffers, the service worker 26 MB of buffers, each idle runtime ~1 MB of heap. A warm
  `vite-react-counter` run (453 MB) had 24 isolates, 12 of them spare runtimes that rolldown's
  WebAssembly threads boot and never use (see Not done).
- **No growth across runs** in one session: 20 warm runs of `vite-react-counter`, then 36 runs of 12
  distinct corpus apps, with a GC after each: the host's heap stayed at 53-54 MB and 60-68 MB, its
  RSS at 273-313 MB and 235-425 MB (the four preload bundles kept, ADR 0029), Chromium's processes at
  355-369 MB between runs (2-3 renderers: the spare tab and closing ones).
- **The host's compiles in memory were bounded by count only**: up to 5,000 (then all dropped), and
  20,000 lowered eval literals. `next-app-router` and four corpus Next.js apps, cold in one session,
  left 36 compiles of 32.7 MB and 818 literals of 18.9 MB, and each new app adds its own.

## Decision

- **A batch starts its projects in the order its earlier batches suggest** (`longestFirst`, default
  on). It reads its latest 20 summaries in its batch directory (`BatchRunSummary.checksMs`, new) and
  starts first the projects with no checks time there (a new project, which may install first; one
  that failed before its checks, which waits out a grace period), then those whose checks took 3 s or
  more (a failing assertion), longest first, then the others by the time before their checks,
  longest first. Only in-browser runs order an in-browser batch (compare's reference runs are kept
  apart). Results and the summary stay in the order given; a first batch runs in the order given.
- **A batch waits for memory** before it opens another app while others are open: below
  `MEMORY_RESERVE` (1.5 GB) available (`orchestrator/memory.ts`: MemAvailable, or, when the
  process's memory cgroup (v1 or v2) has a lower limit, the limit minus what the cgroup uses besides
  its page cache; shared memory counts as used), it waits until an app ends or memory frees up
  (looking again every 500 ms) and says so once in its log. With none open the next always opens.
  `memoryReserve: 0` turns this off.
- **The default `parallel` is one app per core, up to 8** (`defaultParallel()`), for `sandburg
  batch`, `compare` and `runBatch`.
- **The host's compiles and lowered eval literals in memory are least-recently-used maps bounded by
  their size** (`StringLru`): 128 M characters of compiles (those that go out are still on disk,
  `.sandburg/compiled`, one read away), 64 M of literals.

## Consequences

- The branch against origin/main (`scripts/bench-batch.ts` and `scripts/bench.ts`, both sides as
  refs, interleaved, warm, 3 rounds, medians; the same results in every run):

  | Measured | Base | Head | Change |
  |---|---|---|---|
  | 24 corpus apps, `parallel` 3: wall | 45.91 s | 39.52 s | −14% |
  | 24 corpus apps, `parallel` 4: wall | 44.55 s | 37.37 s | −16% |
  | 24 corpus apps, `parallel` 4: per-app median | 7.67 s | 8.08 s | +5% |
  | 24 corpus apps, `parallel` 4: machine CPU | 80% | 94% | |
  | 24 corpus apps, peak renderers (`parallel` 3 / 4) | 2,954 / 3,874 MB | 4,165 / 4,714 MB | +41% / +22% |
  | 12 corpus apps, `parallel` 3 (ADR 0031's batch): wall | 23.82 s | 20.34 s | −15% |
  | 10 Vite 8 fixtures, `parallel` 4: wall | 19.18 s | 18.24 s | −5% |
  | 10 Vite 8 fixtures, `parallel` 4: peak renderers | 2,689 MB | 2,939 MB | +9% |
  | `vite-react-counter`, one warm run (3 + 4 rounds) | 2.00 / 1.94 s | 2.08 / 2.08 s | +4% / +7% |
  | `lit-vite`, one warm run | 1.49 s | 1.49 s | 0% |
  | `next-app-router`, one warm run (3 + 4 rounds) | 4.81 / 4.87 s | 4.94 / 4.79 s | +3% / −2% |

  The corpus batches were faster on the branch in every round, the Vite 8 batch in 2 of 3 (its first
  round followed a warm-up that left little history for those apps); 16/24, 10/12 and 10/10 passed in
  every run. Each side's `.sandburg/` carried over between rounds after one warm-up batch, so the
  branch's batches had summaries to order by. Single runs do not go through the batch code; only the
  compile cache's bound is on their path (its own A/B: `vite-react-counter` 1.92 → 1.99 s, n=5),
  and an A/A of two revisions that differ in batch code only gave 2.28 → 2.14 s (n=5): one warm
  run's noise here is ±6%.

  Each change's own A/B is in its commit message: the order by the earlier runs' time −12/−13% wall
  (24 apps, `parallel` 3 and 4) at +36-46% peak memory, then by the checks first: the same wall,
  −16% peak renderers, then the longest runs after the long checks: −6% (n=5), +4% peak.
- **Against ADR 0031's "heaviest apps first"** (12% slower there): that order came from the
  framework (meta-frameworks, then Vite, then the rest), and a light app with a long check became the
  tail. Here the order comes from each project's earlier runs. On ADR 0031's own batch (12 corpus
  apps, 3 tabs; 3 interleaved rounds, 10/12 passed in each): 23.82 s → 20.34 s (−15%), faster in
  every round, peak renderers 2,700 → 3,312 MB. The branch started `005-vite-vanilla` (a light app
  whose failing assertion waits 16 s) first, then `010-next-app` (a syntax error: no checks time),
  then the other Next.js apps, Vite + React and plain Vite; the heuristic would have put
  `005-vite-vanilla` last. The Next.js apps still run side by side (their per-app times are longer),
  but the batch's wall is its tail, which is now the short apps.
- **Starting the long apps first raises a batch's peak memory** (their renderers are open
  together): on the corpus, peak renderers +41% at `parallel` 3 and +22% at 4, +9% on the Vite 8 batch. **The memory guard bounds it where memory is
  short.** The 24-app batch at `parallel` 4 in a memory cgroup limited to 4.5 GB (a child of this
  session's, so `availableMemory` reads the limit; the whole benchmark ran in it; 2 interleaved
  rounds, 16/24 passed in each): peak renderers 3,788 MB on main and 3,629 MB on the branch (4,606 MB
  without the limit), and the branch was still faster, 44.22 → 42.19 s (−5%). Main was not killed at
  that limit either (the kernel reclaims page cache first), but it has no bound of its own: its
  peak grows with `parallel`, while the branch opens no app with less than 1.5 GB left (apps already
  open can still grow).
- **Behaviour changes**: a batch starts its apps in another order once it has summaries (results
  and the summary keep the order given; `longestFirst: false` keeps the order); `BatchRunSummary`
  has `checksMs`; a batch may open its next app later when memory is short, and logs "waiting for
  memory to open the next app"; `--parallel` defaults to the number of cores (at most 8) instead of
  4 (the same here); a session keeps at most
  ~128 M characters of compiles in memory (more come from `.sandburg/compiled`).
- **Disk**: a benchmark worktree's `.sandburg/` held 2.5-3 GB after the warm-up batches of 24 corpus
  apps (installs, the package store, dev caches, compiles); this round's benchmarks filled the
  session's disk once.

## Security

No boundary changes: each run keeps its own browser context and origin, and nothing new is shared
between runs or projects.

- The start order comes from the user's own batch directory (`.sandburg/batches`, written by
  earlier batches). A tampered or foreign summary can only change the order in which a batch starts
  its apps (a test writes one), never what a run does, sees or shares.
- The memory guard can only start apps later; with no app open it never waits, so it cannot stall
  a batch.
- The compile caches keep their keys (the digest of what was compiled); a bound only drops entries,
  which the disk store or a new compile answers the same. A run cannot raise the bounds.

## What did not help

- **Ordering by the whole run's time** (the longest first) and **by the checks alone**: the same
  wall time (37.77 s against 38.01 s, n=3), but the first starts the heavy apps side by side (peak
  renderers 5,450 MB against 4,598 MB), and the second leaves the heaviest passing apps in the order
  given, last if they come last (the two-key order beat it by 6%).
- **Starting the next app while one waits out a grace period** after it failed to render (2 s after
  an uncaught error, 8 s after a console error): 37.37 → 38.30 s (n=3); such apps already start
  first, having no checks time.
- **Three times `parallel` open** instead of twice (the limit was reached for 4-7 s of a 24-app
  batch): 36.65 → 36.69 s (n=3), the same peak memory.
- **More apps than cores**: see the context (no faster at 6 on 4 cores, nor at 4 on 2 cores).
- **Lowering the renderers' CPU priority** (a higher nice value on Chromium's zygotes, which
  renderers fork from), so that the host and Chromium's browser process, which answer the
  renderers' synchronous requests, get the cores first: Chromium sets its renderers' and their
  threads' priorities itself (5 of ~75 renderer threads kept the inherited value).
- **Memory pressure** (`Memory.simulatePressureNotification`, critical) on an idle Next.js app in its
  checks: its renderer stayed at 1,024 MB.
- Attributing a renderer's memory with other tools: `performance.measureUserAgentSpecificMemory()`
  counts each growable `SharedArrayBuffer`'s reserved 1 GiB (ADR 0029) and waits up to 60 s for a
  GC; Chromium's memory-infra dumps (`Tracing.requestMemoryDump`) fail in this headless build;
  `--trace-gc` output from renderers does not reach Playwright's log; the renderer's mappings
  (`/proc/<pid>/smaps`) are 904 of 945 MB unnamed anonymous memory.

## Not done

- **Spare runtimes in napi-rs WebAssembly threads.** Rolldown's threads (napi-rs' `wasi-worker.mjs`,
  which instantiates the module with `childThread: true` and asks its parent for threads) each boot
  ADR 0027's spares because they load `worker_threads`: 12 idle runtimes in a warm Vite 8 run. Letting
  those threads boot none took that run's renderer from 453 to 359 MB, a batch of the ten Vite 8
  fixtures from 18.18 to 16.37 s and its peak renderers from 3,014 to 2,481 MB (n=3). The same change
  is perf-wasm-tools' (its "No spare runtimes in napi-rs WebAssembly threads"), so it is not here.

- **The resolver's heap** (ADR 0032: the host and npm peak at ~1.1-1.6 GB during cold installs, the
  worker keeping its largest parse until 30 s idle) is the cold-install work's; a batch of new apps
  keeps it alive throughout. A `resourceLimits` cap would send installs to the CLI when hit.
- **A spare tab per `parallel`** at a batch's start: only the first wave of apps opens its own tabs
  (load 0.5-0.9 s), ~1% of a 24-app batch.
- **Sending install and mount data by URL** instead of through `page.evaluate`: Playwright validates
  and serializes each argument (~0.6 s of the host's 8.8 s in a 24-app batch).
