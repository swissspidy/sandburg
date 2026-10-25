# ADR NNNN: The bytes between host, page and runtime

- Status: Accepted
- Date: 2026-10-25

## Context

Data crosses several hops in a run: host → page (the host server's routes, `page.evaluate`, CDP
fulfills), page → runtime (postMessage, shared memory), runtime → host (the file channel), and back.
ADRs 0031, 0041, 0044 and 0046 left costs open on these paths: the preload bundle's download (80-200
ms of a warm run's start), Next.js' dev-cache readback (~2 s of the page's thread in a seed run), the
install data through `page.evaluate`, base64 and JSON on the large paths, and the VFS's copies.

A tracer came first (`SANDBURG_TRACE_TRANSFERS=1`, `src/transfer-trace.ts`): every transfer of 64 KB
or more, with its hop, size, encoding and time, printed on the host's stderr and as a table at
exit. The host traces its HTTP answers and request bodies, the file channel, calls into the host page
and CDP fulfills; the page and the runtime report theirs as marked console messages. What a warm
run (a session's second) moved, before this ADR:

| Hop | vite-react-counter | next-app-router |
|---|---|---|
| preload bundle, host → page (shared memory) | 8.2 MB, ~160 ms | 42.6 MB, ~270 ms |
| dev-cache bundle, host → page | 2.7 MB; the runtime waits 130-160 ms at init | 26.5 MB (webpack's seed); waits 264 ms at init |
| install data, `page.evaluate` (JSON) | < 64 KB | 750 KB (the installed files' index) |
| WebAssembly binaries, host → page | rolldown 11 MB | swc 30 MB |
| compiled code by digest, sync XHR | – | 4 × 4.8 MB, 53-66 ms each |
| cache readback, runtime → page → host | 2.7 MB as text, first runs | 27 MB as base64 JSON, every 250 ms in a seed run |

Three findings shaped what followed:

- **The browser moves ~150-250 MB/s into the page here**, whatever the source: the host serves the
  bundles in 5-60 ms, and Chromium starts each request ~50 ms after the page asks (net log:
  `CORS_REQUEST` to `REQUEST_ALIVE`, while the browser process is busy). Reading the body whole
  (`arrayBuffer()`) instead of chunk by chunk changed nothing; gzip on the wire (4x fewer bytes for
  the preload bundle) was slower (458 ms against ~200-380 ms): the network service inflates it before
  the same pipe.
- **A warm run reads less than half of its preload bundle**: next-app-router's main runtime read 990
  of 2,302 files (16 of 43 MB). The bundle held everything runs of the install had ever loaded, and
  the host's prediction for its first run (ADR 0045), which is recorded as loaded.
- **Everything in Next.js' dev-cache bundle is read** (webpack's packs, 26 MB, already gzip).

## Decision

- **The tracer** stays, off by default (a boolean check per transfer).
- **Preload bundles hold what runs read.** Each runtime tells the host which of its bundle's files it
  read, in batches of 100 over the file channel (a note, as read-ahead's `?used=1` is); files asked
  for one by one count as read. Once runs of an install have reported, its bundle holds the files
  they read, in the order first loaded. Steady state: next-app-router 43.5 → 21.9 MB,
  vite-react-counter 8.4 → 4.5 MB.
- **Dev-server caches are read back in binary.** The runtime answers `read-cache` with the cache's
  files and sizes; a seed run's page compares the lists until webpack has stopped writing, then asks
  for the bytes once: a bundle (the preload format) in one transferred ArrayBuffer, posted to the
  host as is (`application/octet-stream`) and read there into the stored form. `read-tree` keeps only
  the app's own files (`--collect-files`).
- **Large arguments of calls into the host page come from the host server.** A call whose arguments
  are over 16 KB as JSON (a run's install data: the index of 10-12k installed files) stashes them on
  the host server under a random id for the run's sandbox; `page.evaluate` passes the path, and the
  page fetches the JSON once. Playwright validated and serialized the index value by value on the
  host's thread: ~1.8 s of it in a 24-app batch (perf-scale's measurement).

## Consequences

- Per change, interleaved A/B (`scripts/bench.ts`, both sides as refs), medians:
  - read lists, warm, n=5, against the tracer commit: next-app-router 5.37 → 5.55 s (+3%; rounds
    5.2-6.3 s on both sides), vite-react-counter 1.89 → 1.80 s (−5%). Renderer peak, next-app-router
    warm, n=3: 955/980/990 → 985/952/984 MB. Neither moves beyond the noise: half the bytes per run,
    no time.
  - binary readback, cold, n=3: vite-react-counter's dispose (a first run stores its cache)
    0.13 → 0.06 s (−55%); next-app-router 22.76 → 22.29 s, its close (the seed run finishing)
    4.33 → 4.61 s, within noise. A seed run's readback: settled at its first look (250 ms), the bytes
    read in 20 ms, posted by 675 ms.
  - install data, `scripts/bench-batch.ts` (24 apps, `--seed 1`, `--parallel 4`, warm, Playwright's
    headless shell), n=3: wall 35.23 → 34.62 s (−2%), per-app median 7.14 → 6.81 s, host CPU
    14.1 → 13.4 s (−5%), host event loop p99 49 → 43 ms, peak host memory 603 → 535 MB (−11%); the
    renderers' peak 3.7 → 3.9 GB, within what rounds vary (3.9 and 4.1 GB in one round). Single runs,
    warm, n=5: next-app-router's install 0.52 → 0.41 s (−19%), total 5.42 → 5.40 s; vite-react-counter's
    data is under 16 KB (unchanged).
- The branch against origin/quality-structure (`scripts/bench.ts`, both sides as refs, interleaved,
  warm, medians; origin/quality-structure's worktree had run before, the branch's was new, so its
  first round includes the first runs of the install and of Next.js' seed):

  | Fixture | Total | Install | Start | Ready |
  |---|---|---|---|---|
  | vite-react-counter (n=3) | 1.73 → 1.77 s (+2%) | 0.24 → 0.23 s | 0.74 → 0.75 s | 0.33 → 0.36 s |
  | lit-vite (n=3) | 1.33 → 1.38 s (+4%) | 0.20 → 0.14 s | 0.60 → 0.51 s | 0.31 → 0.31 s |
  | sveltekit-app (n=3) | 3.60 → 3.56 s (−1%) | 0.46 → 0.41 s | 1.41 → 1.42 s | 1.19 → 1.13 s |
  | next-app-router (n=4, again) | 5.57 → 5.46 s (−2%) | 0.64 → 0.42 s | 1.19 → 1.19 s | 3.00 → 3.00 s |

  In the first three-round run next-app-router read 5.65 → 6.02 s: its rounds were 5.7/5.6/5.6 and
  9.9 (the new worktree's first)/5.6/6.0 s. Warm totals do not move beyond noise; what changes is the
  host's thread in batches, the bytes per run, and a first run's dispose (above).
- **Behaviour:** a cached text file that starts with a BOM keeps it (the runtime's decoder dropped
  it). A run's preload bundle may lack a file earlier runs loaded but never read; the runtime asks
  for it, and it is in the next bundle again. Nothing an app sees changes.

## Security

- **Read reports** (`/__sandburg/nm/<install>/read`, over the file channel or HTTP from a sandbox's
  own origin) shape an install's bundles only when they come from the sandbox of a run the install
  was made for (`grantReads` at hostInstall, bound once the run's tab is known, dropped after 6
  hours), as do the files such a run asks for one by one. Files are still served by key to any
  sandbox (ADR 0040). The host keeps only entries in that install's index (mode `f` or `t`, the path
  as indexed), at most 1,000 a report. A file missing from a bundle is asked for, never wrong.
  `test/unit/preload-reads.test.ts` tries other installs, modes and escapes, another sandbox's reports
  and requests, and a sandbox granted for another install.
- **The binary cache write** keeps the route's per-run token (issued for one key to one sandbox, once),
  its 256 MB limit, and the filter on what is kept (under the grant's directories, no `..`). A bundle
  whose lengths do not add up, or whose header is not a list of files, is refused and the token kept.
  `test/unit/dev-cache-writes.test.ts` tries both, and another sandbox holding the run's token.
- **Stashed arguments** (`/__sandburg/args/<id>`): the id is 18 random bytes, the stash is served to
  its sandbox's origin only (another sandbox, which shares the host server, gets a 404, as does a
  request from another site, a POST, and a second GET), once, and dropped after 2 minutes or when
  the sandbox is unregistered. The data is what `page.evaluate` handed the same page before
  (including the run's capability tokens). `test/unit/host-server.test.ts` tries each.

## What did not help

- **Streaming the bundles** (the runtime reading a bundle's files as they arrive in shared memory, a
  dev cache's files registered in the VFS and copied on first read, the dev cache's body after the
  preload bundle's): the runtime's wait at init went (install −22% to −41%), and came back in start
  (+5% to +16%): warm totals +1% to +4% (n=5, three fixtures). A warm run here is bound by CPU, not by
  the transfer: the program follows the download. Dropped.
- **gzip on the wire**, and **reading the body whole**: above.
- **Starting the downloads earlier**: the host's install data is ready ~30-40 ms before the install
  call in a warm run (8-27 ms after the run starts); not worth a second call.
- **An ArrayBuffer body for the cache's POST**: DevTools is handed it as the request's post data; a
  27 MB upload took 1.6 s instead of 0.4 s (as a Blob). The compile route's uploads were Blobs
  already (ADR 0041), but 8 MB still costs ~0.35 s to send.

## Not done

- **Compiled code by digest** (`/__sandburg/compiled/<digest>`, 4.8 MB answers, ~60 ms each, four in
  a warm next-app-router run): the digest helper computes a large chunk's digest as soon as webpack
  writes it, and could fetch its compiled code then, on the side, before the program requires it.
  How the runtime loads compiled code is perf-module-loading's.
- **Uploads**: ~45-70 MB/s from the page to the host here (compile requests, cache writes).
- **The swc and rolldown WebAssembly binaries** (30 and 11 MB a run, ~50-110 ms): the same bytes in
  every run of a session; a compiled module cannot cross the browser contexts that keep runs apart.
