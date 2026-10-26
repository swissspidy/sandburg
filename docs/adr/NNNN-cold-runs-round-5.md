# ADR NNNN: Cold runs, round 5: the runtime's compiles over the file channel, whole WebSocket messages, cache writes off the host's main thread

- Status: Accepted
- Date: 2026-10-26

## Context

After ADRs 0045 and 0048-0052, a cold run (empty `.sandburg/`, npm's cache warm) on this 4-core
machine took: astro-app ~15.8-17.3 s (install ~4.2-4.8 s, start ~4.1-4.6 s, ready ~5-6.8 s; warm
~3.6 s), next-app-router ~23-26 s, sveltekit-app ~12.8 s, vite-react-counter ~5.5 s. Phase
timelines (marks at each install step and phase), V8 CPU profiles of every browser thread
(`scripts/profile.ts --cold`) and of the host (`node --cpu-prof`), and a log of every request the host
answered (over HTTP and over the file channel, with its latency) showed:

- **The runtime's compiles were synchronous XMLHttpRequests.** A cold astro-app run's runtime thread
  spent ~6.3 s of profiled time in `hostCompile`: ~340 POSTs of `/compile` (Vite's SSR module runner
  evaluates every server module with `new AsyncFunction`, whose body the host lowers), ~10 ms each
  from the runtime's side, ~3 ms of it the host's compile. Playwright intercepts every request of a
  routed context; the file channel (ADR 0041) took only GETs and esbuild's transforms. With every
  cache but the project's compile cache in place, those compiles alone made ready 4.4 s instead of
  2.0 s.
- **The file channel lost its larger messages.** Chromium sends a WebSocket message over ~32 KB in
  fragments (a frame without FIN, then continuation frames); the host's frame reader took each
  frame for a whole message. A larger POST was answered from its first fragment, and the channel
  closed soon after (~4 s into a cold astro-app run's start): every later request of that runtime
  went over HTTP.
- **Large files were read twice.** The channel answers bodies up to 1 MB; for rolldown's 11 MB
  binary and Vite's 1.4 MB chunk the host read or transformed the file, answered "too large"
  (status 0), and served it again over HTTP (124 + 86 ms, and 264 ms, of the host's thread, while the
  runtime waited).
- **The host's main thread wrote the transform cache through fs/promises**: ~2,000 transforms in a
  cold astro-app run, ~1.4 s of the main thread's samples in `open`, `write`, `close`, `rename`.
- **What a cold start waits for**: in a cold astro-app start (4.5 s), ~2 s of host answers (transforms
  of installed files: 274 requests, 1.55 s; raw files 0.3 s); of the transforms, ~80 had not been
  started by the prefetcher (ADR 0032) when the runtime asked (~1.1 s of waiting, ~14 ms each), the
  rest came from memory or pushes. The ready phase's cold part was the compiles above (2.4 s), the
  rest the start's transforms the dev server loads later (~0.9 s) and Vite's dependency cache
  (~0.3 s). An install is npm's resolution (~3 s of CPU in the resolver's worker for astro-app, with
  trimmed packuments; ~1 s of it loading npm without V8's code cache, which `.sandburg/` holds).
- **Next.js' seed run** (ADR 0026) runs `next dev` beside the first app of its versions for the whole
  of the app's start and ready: the same cold next-app-router run took 21.5-21.7 s without it and
  25.0-25.9 s with it (start +1-1.7 s, ready +2.5 s); `Session.close` waits ~2-2.5 s for the seed's end.

## Decision

- **The runtime's compiles over the file channel** (`postSync` in `src/node-runtime/host-files.ts`,
  `hostCompile` in `worker.ts`). Code under 256 KB (`ASK_FIRST`) is posted over the channel and the
  runtime waits on its mailbox, as for a GET; larger code, an answer over 1 MB, or no channel yet goes
  over HTTP as before. The compile cache's write token, a header over HTTP, travels in the query and
  the channel (`host-socket.ts`) puts it back as that header, so the route checks it unchanged.
- **Whole WebSocket messages** (`readFrames` in `host-socket.ts`): fragments are put together before
  a message is answered; control frames may come between them. A message whose fragments together
  exceed its kind's bound (`MAX_FRAME` for text, `MAX_POST` for binary), a continuation without a
  message, a new data frame inside one, or a fragmented control frame closes the channel.
- **Installed files over the channel's bound go over HTTP at once** (`syncGet` in `host-files.ts`):
  the runtime knows each file's size from the install's index.
- **Transform and compile cache files written on a thread** (`src/adapters/node/file-writes.ts`): the
  main thread posts each file to a writer thread, which writes it synchronously (a temporary file, a
  rename; a directory made once); the write resolves when the file is on disk, so a transform stays
  "in progress" until then, as before. The writer is held open while it has writes.

## Consequences

- This branch against the origin/main it started from (`scripts/bench.ts --base 860c0eb --head
  032f355`, both sides as refs, 3 interleaved rounds, medians):

  | Fixture | Mode | Total | Install | Start | Ready |
  |---|---|---|---|---|---|
  | astro-app | cold | 19.16 -> 17.27 s (-10%) | 5.08 -> 5.03 s | 4.78 -> 4.67 s | 7.86 -> 5.39 s |
  | astro-app | warm | 4.54 -> 4.39 s (-3%) | | 1.14 -> 1.20 s | 2.53 -> 2.42 s |
  | next-app-router | cold | 25.26 -> 25.50 s (+1%) | 5.00 -> 4.74 s | 6.75 -> 6.36 s | 10.77 -> 11.19 s |
  | next-app-router | warm | 5.69 -> 5.63 s (-1%) | | 1.24 -> 1.23 s | 3.25 -> 3.14 s |
  | sveltekit-app | cold | 13.48 -> 13.13 s (-3%) | 3.22 -> 3.30 s | 6.80 -> 6.49 s | 2.29 -> 1.80 s |
  | sveltekit-app | warm | 3.45 -> 3.45 s (0%) | | 1.34 -> 1.40 s | 1.26 -> 1.23 s |
  | vite-react-counter | cold | 6.56 -> 6.24 s (-5%) | 2.63 -> 2.75 s | 1.50 -> 1.25 s | 1.12 -> 1.02 s |
  | vite-react-counter | warm | 1.70 -> 1.62 s (-5%) | | 0.64 -> 0.63 s | 0.45 -> 0.44 s |
  | lit-vite | cold | 5.54 -> 5.06 s (-9%) | 2.42 -> 2.35 s | 1.12 -> 0.96 s | 0.64 -> 0.60 s |
  | lit-vite | warm | 1.27 -> 1.18 s (-7%) | | 0.52 -> 0.47 s | 0.30 -> 0.27 s |

  All 60 runs passed. The machine was busier during this benchmark than during the per-commit ones
  (astro-app warm 4.5 s here, 3.6 s there). The ready phase of a cold Astro run is what the compiles
  over the channel shortened; next-app-router's cold total is within its spread (its seed run beside
  it; `Session.close` 2.19 -> 2.85 s, as the app ends sooner relative to the seed).

- Each change's own A/B is in its commit message. Compiles over the channel (base c626935, 3 rounds,
  all 36 passed): astro-app cold 17.34 -> 15.20 s (ready 6.79 -> 4.66 s), sveltekit-app cold 12.82 ->
  11.60 s, next-app-router cold 25.46 -> 22.86 s (its `Session.close` 1.59 -> 4.01 s: the seed run has
  more left when the app is done; run and close together 27.05 -> 26.87 s); warm runs unchanged.
  Whole messages and large files over HTTP are within the noise on their own (they are what keeps
  the channel open and fast for the rest). Cache writes on a thread: the host's main thread in a
  cold astro-app run 7.99 / 8.47 s busy -> 7.52 / 7.78 s, its fs calls 1.39 / 1.56 s -> 0.29 / 0.24 s;
  run times within the noise.
- Cold-run medians on this machine move ±5-10% between rounds (npm's resolution, the registry's
  revalidations, the seed run beside Next.js); warm runs ±3-5%.
- **Behaviour.** A runtime's compiles (`/__sandburg/compile`) go over its file channel when it is
  open (bodies under 256 KB, answers up to 1 MB); errors are the same. Installed files of 1 MB or more
  are asked for over HTTP. The host writes `.sandburg/transforms` and `.sandburg/compiled` from a
  worker thread. Nothing an app sees changes.

### Security

- **The file channel's boundary is unchanged.** The channel is the sandbox's own: its origin is
  checked at the upgrade and the host server binds it to that sandbox (ADR 0054); a compile over it
  is the compile route HTTP reaches, with the same body bound (`SOURCE_BODY_MAX`, and `MAX_POST` per
  message) and the same answer. A compile is recorded in a project's compile cache only with the
  run's token from that run's sandbox: `test/unit/dev-cache-writes.test.ts` posts compiles over a
  channel bound to another sandbox with the run's token, and over the run's own with no token and a
  guessed one, and only the run's own with its token is recorded. `test/unit/host-socket.test.ts`:
  the token reaches the route as the header and leaves the query; only `esbuild-transform` and
  `compile` are taken as POSTs (other paths, `..` included, answer status 0 and nothing is served).
- **Fragments stay bounded.** The reader keeps at most one message's fragments, at most `MAX_POST`
  bytes; fragments over the bound together, a continuation without a message, a data frame inside a
  message and a fragmented control frame close the channel with nothing served
  (`test/unit/host-socket.test.ts`, with a raw client, as Node's WebSocket never fragments; the frame
  reader's fuzzer, `test/unit/parser-fuzz.test.ts`, passes).
- **The writer thread** writes the files the host wrote before, under the host's own digests; it is
  the host's code on a thread of the host process, and nothing reaches it from a run but bytes the
  host computed. No new route, socket or cache shared across runs.

## What did not help

Measured with interleaved runs (`scripts/bench.ts`, both sides as refs) unless said otherwise.

- **Writing the cache files synchronously on the main thread**, batched per turn of the event loop:
  2,000 small files took 65 ms instead of 287 ms on an idle machine, but in a cold run, beside the
  install's unpacking, the system calls themselves took ~1.2 s of the main thread (`open` ~1.0 s,
  `mkdir` ~0.3 s), no better than the promises. On a thread instead (above).
- **The seed run at the lowest CPU priority**: every thread of the seed's renderer at nice 19 (found
  as the batch's memory guard finds a run's renderer, looked at again every 0.5 s for new threads).
  next-app-router cold, 5 rounds: the run 23.66 -> 23.19 s (start 6.16 -> 6.05 s, ready 10.42 ->
  9.79 s), `Session.close` 2.42 -> 3.28 s: run and close together 26.08 -> 26.47 s. The seed's share
  that slows the app is mostly on the host (its requests, transforms and compiles) and in the browser
  process, which a renderer's priority does not reach. Dropped.
- **Prefetching ahead of the runtime's chain** (prefetch.ts): (a) the files a runtime's request
  requires moved ahead of the prefetch's own queue (and allowed beyond its concurrency): ~85
  transforms were still started by the runtime's own requests, as before; (b) a file's imports found
  in its source as its transform starts (Vite's 1.4 MB chunk takes ~0.2 s to transform idle, ~0.4 s
  in a cold run, and rolldown's chain is found only after it), with the queue depth first: transforms
  started by requests 84 -> 36-56, but the prefetcher stayed busy longer, the predicted preload bundle
  came after 4.5 s instead of 3.3 s, and the runtime made ~1,000 single requests instead of ~330: the
  host's waits ~1.9 s against ~1.6 s. A cold start's ~2,000 transforms bound it, not their order.
  Dropped.

## Not done

- **npm's own code cache on a cold machine**: the resolver's worker loads npm in ~1 s without V8's
  code cache, which lives in `.sandburg/node-compile-cache` (not in the shared temporary directory,
  ADR 0041); a first run with an empty `.sandburg/` pays it on the install's critical path.
- **The transforms a cold start needs** (~2,000 for astro-app, ~1,300 loaded) are the host's main
  cost left; they are shared by content across projects, so only a machine's first project of a stack
  pays them. A transform of a large file (Vite's 1.4 MB chunk: esbuild ~150-180 ms) is one esbuild call;
  splitting it would not shorten the chain behind it.
- **Next.js' seed beside the app** costs the app ~3.5-4 s of a cold run on 4 cores (above); starting it
  after the app's checks would make `Session.close` the whole seed run (~8 s or more). Which one a
  user feels depends on whether the session runs more apps; not changed.
- **Large compiles** (code over 256 KB: next dev's chunks) still go over HTTP: their answers are
  mostly over the channel's 1 MB bound.
- **Starting the program before the install is done**: in a cold astro-app run the install's last
  steps after npm's resolution (unpacking the rest, WebAssembly builds, the index) take ~0.9 s, and
  the program's first requests need packages that are unpacked last; the index the host's checks rely
  on is made once the tree is final. At most ~0.5 s, for a change of how installs are read; not built.
