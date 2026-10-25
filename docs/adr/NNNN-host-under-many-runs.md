# ADR NNNN: The host under many runs: where a batch waits, and caches several sessions share

- Status: Accepted
- Date: 2026-10-25

## Context

Every run of a batch goes through one host Node.js process (npm, transforms, the file channel, the
egress gateway, Playwright) and one Chromium browser process. This round measured where a batch of
many apps waits on them rather than on its own renderer, on a 4-core machine with 15 GB: 24 apps
from `scripts/corpus` (seed 1; 16 of them pass), warm, `parallel` 4, sampled from `/proc` by
process and by thread, with the host's event loop delay and V8 CPU profiles of the host.

- **CPU by process.** With full Chromium (`SANDBURG_CHROMIUM`, as the benchmarks run): wall 34-38 s;
  renderers 90-96 CPU s, host 14-15 s (its main thread 13.5 s, 39% of the wall), browser process
  14-15 s (main thread 8.9 s, IO thread 2.9 s, DevTools pipe 0.9 s), network service 3.3 s, GPU
  process 2.1 s. With Playwright's headless shell (what Sandburg launches when `SANDBURG_CHROMIUM` is
  unset): wall ~30.3 s; renderers 82 s, host 14.2 s (main thread 13.3 s, ~44% busy), browser 7.7 s
  (main 4.3 s, IO 2.0 s), network 3.0 s, GPU 1.5 s. The machine was 93-99% busy from the first
  second to the last (`longestFirst`, ADR 0039, left no idle tail): the batch is CPU-bound, and on
  this machine only less CPU makes it faster.
- **Inside the renderers**: the runtimes' workers 50 s, V8's background threads (compiles, GC) 23 s,
  the pages' main threads 14 s, compositing 0.3 s.
- **The host's main thread** (headless shell, warm): Playwright ~60% of its busy time (5.5-5.8 s),
  file and socket calls 1.4 s, GC 1.1 s. Its longest tasks were `host('install')` (the install data,
  with the install's whole file index, serialized by Playwright: 100-190 ms), walking each install's
  node_modules for its index (once per install and process: 50-300 ms for a Next.js install's 12,500
  files), and parsing each app's dev server cache (up to 36 MB of JSON) to hash its files.
- **How much a busy host costs the others**: 40 ms of busy work injected every 200 ms on the host's
  main thread (+17% of its time, ~4% of the batch's CPU) made the batch 9% slower (34.7 → 37.9 s,
  n=2): a runtime waits on its synchronous requests (ADR 0029), so a host task holds up every open
  app.
- **An idle app** (in its checks, 10 s): host 0.17-0.31 CPU s, renderer 0.06 s (Vite) or 0.5 s
  (Next.js), browser 0.03 s. Idle apps are not what slows a batch.
- **A tab**: a context, a page, a navigation and a close cost the browser process 172 ms of CPU in
  full Chromium (the page alone 97 ms: a window in new headless mode) and 36 ms in the headless shell.
- **Several Sessions or processes on one `.sandburg/`**: two installers finishing the same install
  replaced each other's directory (the second removed the first's, which its runs were reading, and
  renamed its own copy in); an egress cache entry's body and metadata were two renames, so two
  fetches of one URL could leave one's metadata with the other's body; preload lists were written
  whole from each process's memory, the last writer dropping the other's entries; the resolver's
  config files were truncated and rewritten by each process; the code cache's temporary file was
  named by the process id alone.

## Decision

- **Concurrent writers.** An install another writer finished first is kept and the second one's copy
  removed (`settle` in `install.ts`; temporary directories named with random bytes, not the time). The
  egress cache's metadata records the SHA-256 of its body, checked on read (a mismatch is a miss;
  entries without it are read as before, so an offline cache keeps working). A process merges the
  preload list on disk into its own before writing it, when the file changed since it last read or
  wrote it. The resolver's config files are written once, atomically. Code cache entries are written
  to temporary files of their own.
- **Installs keep their index** (`.sandburg-index.json` beside node_modules): written as the install is
  made (the installer walked it then anyway), or by the first process that walks an older install;
  later processes read it (~5-10 ms of JSON) instead of walking. An install does not change once made.
  A stored index that is not an object of node_modules paths without `..` segments and numeric sizes
  is walked again; nothing is written into an unfinished install.
- **Dev caches keep their files' digests** (`<key>.json.digests`), with the size, modification time and
  directories of the cache file they came from: a run whose cache has not changed reads them instead
  of parsing the cache to hash it. Anything else computes them again.

## Consequences

- The branch against origin/quality-structure (`scripts/bench-batch.ts`, both sides as refs,
  interleaved, warm, n=3, medians; each side's `.sandburg/` carried over between rounds after one
  warm-up batch):

  | Measured | Base | Head | Change |
  |---|---|---|---|
  | 24 corpus apps, headless shell: wall | 35.55 s | 32.80 s | −8% |
  | the same: host CPU | 14.9 s | 13.3 s | −11% |
  | the same: host event loop delay p99 / busy | 55 ms / 38% | 40 ms / 36% | −27% / −5% |
  | the same: renderer CPU | 95.9 s | 90.2 s | −6% |
  | 24 corpus apps, full Chromium: wall | 42.03 s | 41.61 s | −1% |
  | the same: host CPU | 15.9 s | 14.6 s | −8% |
  | the same: host event loop delay p99 | 57 ms | 51 ms | −11% |
  | the same: renderer CPU | 108.0 s | 108.0 s | 0% |
  | `vite-react-counter`, one warm run (`scripts/bench.ts`, full Chromium) | 1.87 s | 1.77 s | −5% |
  | `lit-vite`, one warm run | 1.27 s | 1.33 s | +5% |
  | `next-app-router`, one warm run | 5.39 s | 5.58 s | +3% |

  With the headless shell the branch was faster in every round (36.4 against 40.3 s, 32.2 against
  34.8, 32.8 against 35.5); with full Chromium in one of three (42.3/42.0, 40.8/42.8, 41.6/40.6 s).
  The host's CPU fell in both by 1.3-1.6 s (−8 to −11%), which on a CPU-bound batch is worth ~1-2%
  of the wall; the renderers' CPU, which these changes do not touch, differed by 6% between the two
  sides with the headless shell and not at all with full Chromium, so most of the headless shell's
  −8% is the machine's noise (it drifted by ~20% over the day: the same base took 30-42 s). The
  single warm runs (a fresh session running each fixture twice: the second run, measured, finds
  its index and digests in memory either way) are within one warm run's noise here (±6%, ADR 0039);
  16/24 passed in every batch.

- Each change's own A/B is in its commit message: the stored install index, 24 apps (headless
  shell) 34.20 → 31.91 s, host CPU −10%, event loop delay p99 66 → 50 ms, and one-off CLI runs
  next-app-router 6.46 → 6.38 s, vite-react-counter 3.90 → 3.80 s (n=5); the stored digests,
  37.63 → 35.09 s, host CPU −8%, peak host memory −12%. In both A/Bs the renderers' CPU also
  differed by 4-6% between the two worktrees, which these changes do not touch: part of each wall
  difference is the machine's noise; the host's CPU is the reliable part.
- **Behaviour changes**: installs have a `.sandburg-index.json` (written into installs made before
  on their first use); dev caches have a `.digests` record beside them; egress cache metadata has a
  `body` digest; a second process finishing an install another finished keeps the first. Nothing a
  run or an app sees changes.
- test/unit/concurrent-writers.test.ts (two installers on one install, an egress entry with
  another writer's body, two copies of the node adapter writing one preload list: each fails
  without its fix), test/unit/install-index.test.ts, test/unit/dev-cache-writes.test.ts (digests),
  and test/e2e/batch.test.ts (two Sessions in one process running apps side by side).

## Security

- **Installs**: the stored index is the allowlist of an install's servable files. It is derived by
  the host from the install it describes and kept in the host's own `.sandburg/installs/<key>/`,
  outside node_modules, where npm extracts packages (npm runs with `--ignore-scripts`), so no package
  can supply it; it is validated on read (node_modules paths, no `..` segment, numeric sizes), and
  the walks that write it skip symlinks as before. `raw()` and `file()` keep their own checks (install
  key format, no `..`, under node_modules/). Keeping the first finished install changes no file a run
  reads (an install is content-keyed).
- **Egress cache**: keyed as before; it only trusts less (a metadata/body pair that does not match is
  fetched again). The gateway's allowlist, methods and redirects are unchanged.
- **Dev caches**: the digests record only decides whether a run's page stores its cache again, as the
  digests did; caches are still written only with their run's token from its sandbox, and the record
  is never served to a page.
- Nothing new is shared between runs, and no route, socket or worker was added: each run keeps its
  own context, origin and egress proxy.

## What did not help

- **The host's file work on worker threads** (a pool for index walks and the dev caches' parse,
  digests, bundle and write): full Chromium 38.50 → 38.60 s (n=3), the main thread 8% less busy,
  host CPU +3%, peak host memory +14%; headless shell 31.82 → 31.59 s, event loop delay p99 −17%,
  host CPU +8%, peak host memory +6%. It moved the work without removing it; keeping its results
  (above) removed it.
- **Playwright's server on a worker thread** (`launchServer` there, `connect` over loopback): the
  main thread 34 → 27% busy, but host CPU +40% (every message as JSON both ways, where the in-process
  connection passes objects) and the batch slower, 30.3 → 31.8 s (n=3); a batch of 24 light Express
  apps at `parallel` 8, where the host's work is most of it, 6.1-6.5 → 7.2-7.4 s, host CPU +60%.
- **Two host processes, each with its own browser**, at `parallel` 2 each, against one at 4: 38.0 and
  42.1 s against 34.1 and 34.2 s (the halves of the batch, n=2).
- **Fewer Playwright events**: one `request` listener (for `network.requests`) and one `response`
  listener (documents) make Playwright create Request and Response objects and send request, response
  and requestFinished for every request (~2,500 events and 1,700 objects per batch); without them the
  light batch was as fast (5.72-6.08 against 5.81-6.05 s, n=3).
- **The egress interception's cost** (Fetch domain on HTTPS): without it, 6 apps' browser CPU was the
  same (3.7-4.0 against 3.9-4.1 s).
- **V8 flags for every renderer**: `--max-opt=2` (no TurboFan) 31.0 against 31.6 s (n=3), renderer
  CPU −4%, too little to give long builds their optimizing tier; `--max-opt=1` slower (32.8 s);
  `--no-opt` 32.5 s (n=1). A larger young generation for the host (`--max-semi-space-size=32`): no
  difference (n=2).

## Not done

- **The install data by URL** (ADR 0039's open item): Playwright validates and serializes each
  `evaluate` argument object by object (an argument of 200 small objects: 6.7 ms of the host's CPU,
  against 0.8 ms as one JSON string over DevTools), and the install data carries the install's whole
  file index; the host's longest remaining tasks. perf-data-paths has it.
- **Past ~8 apps at once**: the host's main thread spends 0.4-0.55 s per corpus app (0.19 s per light
  Express app), most of it Playwright; one host is ~44% busy at `parallel` 4 and would be saturated
  around 8-9, which is where `defaultParallel()` stops. A larger machine needs a batch split over
  host processes, each with its own browser; the concurrent writers above are its prerequisite. On 4
  cores it only cost (see above).
- **Playwright's own per-call costs**: an Error with a captured stack for every DevTools command
  (`ProtocolError`), 50 frames per API call (`captureRawStack`), `new Error().stack` per evaluation
  race: ~0.4 s of the host's main thread per 24-app batch.
- **Full Chromium's tabs**: 97 ms of the browser process per page against 17 ms in the headless shell;
  benchmarks with `SANDBURG_CHROMIUM` set to full Chromium overstate the browser process's share of a
  batch (14-15 against 7.7 CPU s).
- **Bytes per run**: a warm Vite run reads ~25 MB from the host, a warm Next.js run ~120 MB (its 52 MB
  preload bundle, swc's 30 MB WebAssembly, its 18 MB dev cache bundle), through the network service
  (3 CPU s per batch); perf-data-paths' area.
- **Preload lists in a long-lived host** grow with each install (~180 KB of strings each); the host's
  heap went 51 → 88 → 110 MB over 48 distinct apps, mostly its bounded caches filling.
