# ADR 0060: Test reliability under load: waits for the thing, not for a time

- Status: Accepted
- Date: 2026-10-26

## Context

CI runs the unit suite, the runtime suite (Chromium) and each e2e file as a job of its own on every
pull request, and the suites are often run locally beside other heavy work. Tests had failed
intermittently: the batch suite's renderer-memory race (`rendererPeakBytes` null; fixed in ADR 0046's
round, in #67), an uncaught `ECONNRESET` in its canary (#62), and the runtime suite's prefetch and
files tests when the machine was busy. GitHub Actions' history (the last 100 CI runs) shows one kind
of failure only: four `E2E (batch)` jobs with `app-4: null`, all before #67 merged; none since.

This round ran every suite again and again, idle and under load, on a 4-core machine with 15 GB:
CPU spinners (one per core, or two per core), a disk writer (64 MB written and synced in a loop), the
unit suite looping beside the runtime suite, two e2e loops at once (origin/main and this branch, in
two checkouts), two copies of a suite at once on one `.sandburg/`, and Chromium on two cores
(`taskset -c 0,1`). `scripts/flakes.ts` (new) does each of these.

What failed, and why:

| Suite | Test | Seen | Cause |
|---|---|---|---|
| runtime | zlib streams; fs streamed writes | 4 in 34 loaded runs of origin/main | The harness ended every run without requests 3 s after it started, exited or not. These programs exit on their own; loaded, they took 3.05-3.08 s, and stdout came back empty. |
| runtime | a program's transforms over the file channel; installed files (bundle and threads, prefetch) | 4 in 34; 1 in 15 runs of the two files alone | The program waited 300 ms "for the file channel to open", then expected its requests over it (`http` where `ws` was expected). |
| runtime | a dev proxy and its API (`node api.js & node web.js`) | (by reading) | web.js asked the API 300 ms after both started. |
| runtime | a shell script ends with its foreground command | 1 in 10 (with the fixes above) | The background command printed after the foreground's 300 ms timer when it took longer to start. |
| unit | a batch starts its next app when one reaches its checks | 1 in 10 | "slow" slept 200 ms in its checks and was expected to end after five others whose timers added up to more than that on a loaded machine. |
| e2e batch | a batch of 10 projects … | 1 in 5 runs of 2 copies | The two runs after the first eight were expected to take under 5 s in their install phase (they take the install from the cache); with two batches at once one took 5.1 s. |
| e2e node | the first Next.js app of each router starts a seed run … | 2 in 2 runs of 2 copies | Both copies removed the stored seeds; the second `rm` of a removed file threw ENOENT (and the next test, which needs the seeds, failed with it). |
| runtime (product) | read reports before the file channel opens | found while fixing the above | A runtime reports which of its preload bundle's files it read 500 ms after its first read; the channel's helper dropped a report while its WebSocket was still connecting. |

Nothing else failed: 50 e2e suite runs on each side (every suite but reference 5 times, two loops at
once, 2-4 spinners), 10 unit runs and 32 runtime runs on this branch under the loads above.

Three tests waited a fixed time for work the host does in the background and had not failed, with
their margins: read-ahead and preload-reads (50 ms for a record to land) and concurrent-writers'
preload-list test (1 s, 1.5 s and 1.5 s of real time around a 2 s timer, 500 ms of margin either
side). 30 runs of the six most timing-sensitive unit files, under two e2e loops and four spinners,
passed on both sides.

And the unit suite left 42 directories, 16 MB, in the system's temp directory per run (ten files
never removed what they made; two had theirs made again by the host's preload-list timer after their
`after()` removed them): 380 MB after this session's first 24 unit runs, on a machine whose disk is a
fixed allowance. The page-checks suite left one per run too.

## Decision

- **The runtime harness ends a run on what it waits for.** A run ends when its program exits (as
  before), or when the test's `until` holds for what it printed and what the host was asked for
  (looked at every 25 ms); a 30 s backstop only ends a run that hangs. A program that does not exit (a
  server, a thread: threads do not exit on their own in this runtime) says what it waits for.
- **`channelOpen()` and `holdChannel`.** `CHANNEL_OPEN` (in `test/runtime/harness.ts`) gives a program
  `channelOpen()`, which resolves once its requests go over the file channel: it probes the runtime's
  esbuild hook, and the harness answers a probe with the way it came (`"ws"` or `"http"`) and does
  not record it. With `holdChannel`, the harness accepts the channel's WebSocket only once a program
  has probed, so "over HTTP at first" holds by construction. The files and native-transform tests use
  both instead of 300 ms timers.
- **Clients that ask again, and commands that wait for each other**: the API test's client asks
  again while the API refuses connections (at most 10 s), as a dev proxy does; the shell test's
  foreground command ends 300 ms after the background one has written its file (so the background
  one has ended first; a slow machine can only hide a regression, not fail a correct shell).
- **The unit batch test's slow app waits for the others** (or 5 s), instead of 200 ms.
- **Mocked timers for the preload-list writers** (`mock.timers`, advanced by the test), and polls
  with a deadline where a test waited 50 ms for a record.
- **The batch e2e checks the order, and the time with a measured margin**: it records when the
  batch's own install on the host was done (its key only) and when each of the batch's runs asked for
  its install (not the session's Vite seed run, which asks for the same install on a cold
  `.sandburg/`), and checks that the two later runs asked after it was done (with parallel 10, it
  fails). Their install phase must stay under 10 s instead of 5 s: 0.3-1.7 s idle, 5.1 s at most with
  two batches at once and two spinners on 4 cores; a cache hit made to wait 11 s fails it.
- **The node e2e's seed test** removes seeds with `force` and skips one removed while it lists them.
- **Read reports wait for the channel** (`src/node-runtime/host-files.ts`): the helper keeps notes
  made while its socket is connecting (at most 256) and sends them when it opens; a socket that closes
  drops them, as before. Test: the harness holds the channel past the report's timer; without the fix
  the report never comes.
- **`test/unit/temp-dir.ts`**: `tempDir(prefix)` makes a directory and removes it when the file's
  process exits, after any late write. The page-checks suite removes its directory in `after()`.
- **Test servers' sockets**: the egress proxy tests' echo servers get the `error` listener the batch
  canary got in #62.
- **`scripts/flakes.ts` and `docs/testing.md`**: run test files N times (`--runs`), with spinners
  (`--cpu`), a disk writer (`--disk`) or N copies at once (`--copies`); it counts failures per test and
  keeps each run's output. The page says how to look for flakes and the patterns that fix them.

One bound was widened, with the measurement above: the batch's later runs' install phase, 5 s → 10 s.
No other assertion was loosened; the two wall-time checks in the runtime suite (zlib streams under
2 s, fs streamed writes under 3 s) stay: they measured 64-69 ms and 553-640 ms, idle and loaded alike.
Each changed test was checked to fail with the bug it guards put back: the read-report test
(notes dropped again), the shell test (a script that ends with its background command: 3 of 3 fail),
the files and native-transform tests (requests never over the channel), read-ahead and
preload-reads (loads and reads not recorded), the preload-list test (no merge of the other
process's entries), the unit batch test (a slot freed at a run's end), and the batch e2e (parallel
10; a cache hit delayed 11 s).

## Consequences

Runs and failures, before (origin/main 860c0eb) and after (this branch), under load:

| Suite | Load | origin/main | this branch |
|---|---|---:|---:|
| unit (304 tests) | 4 spinners, dd loop, runtime suite beside it | 1 of 10 | |
| unit | disk writer, two copies of four heavy e2e suites beside it | | 0 of 10 |
| runtime (78/79 tests) | 4 spinners, dd loop, unit suite looping | 6 of 12 | 1 of 6 (*) |
| runtime | 8 spinners, disk writer | 1 of 6 | 0 of 6 |
| runtime | 4 spinners, disk writer (± the unit suite) | 0 of 16 | 0 of 10 |
| runtime | Chromium on 2 cores, two e2e suites beside it | | 0 of 10 |
| runtime: files + native-transform only | two e2e loops, 4 spinners | 1 of 15 | 0 of 15 |
| e2e, each of 10 suites | the other side's loop beside it, 2-4 spinners | 0 of 5 each | 0 of 5 each |
| e2e batch, run, websockets, fullstack, page-checks | 2 copies at once, 2 spinners | | 1 of 5 before the batch fix |
| e2e frameworks, node, vite-frameworks, angular | 2 copies at once | | 2 of 2 before the seed fix, 0 of 5 after |

(*) "spares whose script does not load are not used": see below; not fixed here.

- The renderer-memory race of ADR 0046 holds: the batch suite's `rendererPeakBytes` check passed in
  every one of its 20 runs here, 10 of them two batches at once.
- The runtime suite is faster, no longer waiting out 3 s timers: 45 s → 39.5 s idle (n = 2),
  63-68 s → 50-53 s loaded. concurrent-writers' preload test: 4 s → 20 ms.
- A unit run leaves no directory in the temp directory (was 42, 16 MB).
- Runs are unchanged but for the read reports (a run whose channel opens late now reports its first
  reads): `scripts/bench.ts --base origin/main --head HEAD`, interleaved, 3 rounds, medians of the
  time to the result: lit-vite warm 1.45 → 1.43 s, cold 6.34 → 6.11 s; vite-react-counter warm
  1.91 → 1.78 s, cold 7.31 → 7.11 s (noise).
- **Behaviour changes:** the read reports above. For tests: the runtime harness's `run` and
  `runInstalled` take `until` (and `runInstalled` `holdChannel`); its backstop is 30 s instead of
  3 s.

The slowest tests (warm, loaded, one run of each suite), for whoever looks next:

| Suite | Time | Slowest | |
|---|---:|---|---:|
| node | 108 s | the first Next.js app of each router starts a seed run (removes the seeds: two cold webpack builds with their seed runs) | 60 s |
| browser-install | 96 s | next-app-router installed in the browser | 37 s |
| vite-frameworks | 77 s | a SolidStart app's Babel compiles are kept for its next run | 18 s |
| angular | 61 s | four Angular apps | 10-12 s each |
| batch | 52 s | a batch of 10 projects | 30 s |
| run, frameworks, fullstack, node | | the app-bug tests (a TSX, Svelte or Vue syntax error, SCSS without a preprocessor, an undeclared import, a broken API route, a page that throws) | 10-12 s each, ~75 s in all |
| websockets | 21 s | Next.js hot reloading | 13 s |

## What did not help, or was left out

- **A spare whose script fails to load, taken before its failure is seen** (product; for the
  runtime's owners). The runtime test "spares whose script does not load are not used" serves no
  `node-spare.js` and starts its thread 500 ms after the program; failed once in 6 runs under the
  heaviest load (`worker error: Uncaught Error`). A spare's failed load is seen when its `error`
  event is handled on the parent's thread; a thread that takes the spare before that gets the error
  (its init message, and the ports it carried, went to a worker that never ran). Telling the failure
  apart needs either a load signal from the spare that does not need a task on the parent (it must
  keep working for a blocked parent, the reason spares exist) or a fallback that re-sends the init
  with new ports; neither is small, and only a host that does not serve `node-spare.js` meets it.
- **worker_threads' threads never exit on their own** (product; known-bugs area). In Node a worker
  whose event loop is empty exits, and its `exit` event fires; here a thread ends only with
  `process.exit()` or an error, so `w.on('exit', …)` never fires and a program waiting for it does not
  end (the files and native-transform tests waited for it and were ended by the harness's timer).
  Threads keep their process alive even unref'd because napi-rs' WebAssembly threads have work the
  runtime cannot see, so exiting idle threads needs a way to tell those apart.
- **The app-bug tests' 10 s** come from the ready phase's 8 s console grace (ADR 0043 noted it): a
  faster verdict for a build error belongs to the run's ready phase, not to the tests.
- **The seed test's 60 s** is what it tests (two cold webpack builds and their seed runs); the test
  after it needs its seeds, so the two stay in that order.
- **A longer backstop for the runtime's WebSocket runs** (3 s): they end on close or rejection, took
  under 1 s loaded, and never hit it; left as it is.
- **CPU spinners as Node processes** load the machine less than the shell loops that first showed
  the runtime flakes (0 of 16 runs failed on origin/main with them): the table gives each load.
