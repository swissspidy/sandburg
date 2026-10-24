# ADR 0038: The dev tools' WebAssembly threads

- Status: Accepted
- Date: 2026-10-24

## Context

Vite 8 (rolldown, oxc), Astro's compiler and the other napi-rs builds run as wasm32-wasi WebAssembly
with threads: each thread is a runtime of its own, in a nested Web Worker (ADR 0012), and a runtime
keeps spare runtimes for them (ADR 0027), because a browser cannot start a worker while its parent
blocks. Traces of warm runs on a 4-core machine (Chromium tracing with V8's CPU profiler, the
`v8.wasm` categories, and timestamps logged by the runtime and its threads) showed where the
threads' time went:

- **Spares nobody took.** A runtime boots spares when it loads `worker_threads` or its install has a
  `-wasm32-wasi` package, and a napi-rs build's thread (its `wasi-worker.mjs`) does both. Each of
  rolldown's four threads in a Vite start booted four spares of its own: 16 workers compiling the
  runtime's 0.86 MB script (100-180 ms of CPU each), none ever taken. emnapi's threads start no
  threads: they ask the thread that loaded the build to (a `spawn-thread` message).
- **Spares that were not ready.** The program's runtime woke its spares as rolldown loaded
  `node:wasi`, 280 ms into a Vite start; they received the wake-up at 580 ms, and the init of
  rolldown's first thread arrived 500 ms after it was sent. Chromium holds a parent's messages to a
  new worker until the parent's thread has run a task after the worker's script has run. In a
  microbenchmark, a worker that starts a nested worker and stays busy has its messages to it
  delivered only when it is idle again (400 ms later); once it was idle for 20 ms after the start,
  at once. A runtime loading Vite is busy for hundreds of milliseconds at a time.
- **Round trips to a busy parent.** A thread's file system calls run on its parent's (ADR 0012),
  installed packages aside. Module resolution in rolldown's threads also asked about paths the
  install does not have (`@napi-rs/wasm-runtime/node_modules/@emnapi/core`): 130-200 ms each while
  the parent ran the dev server or waited in WebAssembly.
- **What did not show.** Posting a `WebAssembly.Module` or rolldown's 1 GiB shared memory to a worker
  takes 0.1 ms. Lazy compilation (Liftoff, on first call) is ~75 ms of the main thread and 22 ms of
  synchronous compile for rolldown's 11 MB module; a rolldown thread compiles ~140 ms lazily. The
  samples a profile puts in `postMessage` under emnapi's `threadSpawn` (240 ms of an Astro run's main
  thread) are the main thread blocked in WebAssembly after the post: the post takes under 2 ms.
  rolldown is built with SIMD already (`target_features`: simd128, atomics, bulk-memory).

## Decision

- **No spares in a napi-rs build's threads** (`wasiChildThread` in `node-runtime/worker.ts`): a
  runtime whose entry is a `-wasm32-wasi` package's `wasi-worker.mjs` boots none. Should one start a
  thread after all, it gets a new runtime, as when no spare is left.
- **Threads tell uninstalled node_modules paths without asking** (`trackNodeModulesWrites`,
  `ThreadVfs.local` in `node-runtime/threads.ts`). The main runtime keeps a flag in shared memory
  that it raises once anything is written, made, renamed or removed in a node_modules directory,
  dev-server caches aside (`node_modules/.vite`, `.cache`, `.tmp`, `.astro`, `.svelte-kit`, which
  threads always ask about), apart from making a directory the install has. Threads and child
  processes share it. While it is down, a thread answers "not there" itself for a node_modules path
  the install lacks (paths normalized first).
- **Spares that are ready when the program starts its threads:**
  - the page has the program's runtime start its spares as the run mounts (a `spares` message
    before init, `SPARES_AT_MOUNT` in `adapters/node/browser.ts`), while the runtime waits for the
    install: for Vite and the dev servers built on it, Angular, and projects of several packages
    (which run child processes);
  - a spare loads `/__sandburg/node-spare.js` (`SPARE_SCRIPT` in `node-runtime/bundle.ts`), a stub
    that loads the runtime's script only when it is woken or taken. The host, its service worker
    and the static site's serve it; a spare whose script fails to load is dropped;
  - a woken process keeps two spares woken (`AWAKE_AHEAD`) and wakes the next as one is taken,
    instead of waking all at once.

## Consequences

- The branch against origin/main (`scripts/bench.ts`, both sides as refs, interleaved, 3 rounds,
  medians of the time to the result), warm:

  | Fixture | Total | Start | Ready |
  |---|---|---|---|
  | vite-react-counter | 2.50 s → 2.13 s (−15%) | 1.18 → 0.87 s | 0.60 → 0.52 s |
  | lit-vite | 1.74 s → 1.62 s (−7%) | 0.93 → 0.74 s | 0.28 → 0.26 s |
  | svelte-vite | 2.93 s → 2.56 s (−13%) | 1.27 → 1.01 s | 0.60 → 0.48 s |
  | astro-app | 5.84 s → 5.78 s (−1%) | 1.65 → 1.49 s | 3.29 → 3.22 s |
  | angular-tasks | 6.35 s → 5.91 s (−7%) | 4.36 → 4.04 s | 0.71 → 0.58 s |
  | sveltekit-app | 5.65 s → 5.24 s (−7%) | 1.86 → 1.61 s | 1.56 → 1.37 s |
  | next-app-router | 6.35 s → 5.78 s (−9%) | 1.46 → 1.46 s | 2.96 → 2.93 s |
  | node-express | 0.73 s → 0.78 s (+6%) | 0.23 → 0.27 s | 0.09 → 0.08 s |

  next-app-router's difference is one round's checks (its start and ready are unchanged), and
  node-express's is noise: 0.70 → 0.74 s with flat phases at n=8, and +0% for each change that
  could touch it (8 rounds each).

  Cold (install included; npm's cache warm):

  | Fixture | Total | Start + ready (after the install) |
  |---|---|---|
  | vite-react-counter | 8.65 s → 7.81 s | 3.02 → 2.58 s (−15%) |
  | lit-vite | 6.82 s → 6.31 s | 2.19 → 1.91 s (−13%) |
  | svelte-vite | 14.64 s → 13.33 s | 7.55 → 7.07 s (−6%) |
  | astro-app | 28.14 s → 23.46 s | 16.41 → 15.26 s (−7%) |
  | angular-tasks | 28.77 s → 22.61 s | 12.30 → 11.32 s (−8%) |

  The totals move with npm's install, which this work does not change (its phase was 9-34% shorter
  on the branch's side here: npm's own variance, as in ADR 0030).

- Each change's own A/B is in its commit message; the largest: no spares in napi-rs threads,
  vite-react-counter 2.36 → 2.11 s and lit-vite 1.75 → 1.56 s (n=4); ready spares, the start phase
  of vite-react-counter 1.01 → 0.81 s, lit-vite 0.85 → 0.64 s, sveltekit-app 1.85 → 1.55 s (n=4).
- CPU: the browser's processes used 5.38 → 4.50 s of CPU for a warm vite-react-counter run and
  11.02 → 10.22 s for astro-app (medians of 3, interleaved, origin/main against the branch; the
  next run's tab opening beside the run included).
- A rolldown thread's calls to its parent in a warm vite-react-counter run: 40-68 → 5-17; the first
  thread's init arrives 6 ms after it is sent (was 500 ms).
- **Behaviour changes:**
  - A Vite, Astro, SvelteKit, Nuxt, SolidStart, React Router or Angular app's runtime, and one of a
    project with several package.json files, starts four spare workers as the run mounts, whether
    or not its program starts threads (each an idle worker with a 0.5 KB script until used).
  - Spares load `/__sandburg/node-spare.js` before `node-worker.js`. A host that serves the runtime
    itself (the static site, an embedder) must serve it next to `node-worker.js`; one that answers
    it with `node-worker.js` gets the spare banner as before, one that does not answer it gets no
    spares (threads then start as new runtimes, and one started while its parent blocks waits).
  - A napi-rs build's thread that starts a thread itself gets a new runtime (none do: emnapi
    spawns them from the thread that loaded the build).
  - A file a program writes into node_modules (outside its caches) makes threads ask the parent
    about node_modules paths again, as before; nothing else changes for them.

## Security

- The spare stub is a static script, the same for every sandbox, served like `node-worker.js` (the
  host server's existing checks apply: the sandbox's own origin, `Sec-Fetch-Site`). It takes no
  input and carries no data.
- The node_modules flag is a `SharedArrayBuffer` that the main runtime creates and passes to its
  own threads and child processes, as it passes its preload bundle (ADR 0029): it never leaves the
  run's tab, and it only decides whether a thread asks its parent or answers "not there" from the
  install index it already has. A program can raise it (by writing into node_modules), which only
  makes its threads ask again.
- No cache, route or socket is shared across runs or projects; the sandbox boundaries are as they
  were.

## What did not help

Interleaved warm A/B unless noted, n=4:

- **Eager WebAssembly compilation** (`--no-wasm-lazy-compilation`): vite-react-counter 2.21 →
  2.49 s, start 1.00 → 1.18 s.
- **Compiling the napi-rs `.wasm` ahead** (`WebAssembly.compile` of the installed file as the runtime
  starts, for V8's module cache): it finished 625 ms in (the file comes with the preload bundle),
  after the program's own synchronous compile, which the cache did not serve.
- **A lower tiering budget** (ADR 0027's is 100× V8's default): 10× gave vite-react-counter −7% but
  lit-vite +7%, sveltekit-app +2%, astro-app −1% (n=3); 30× lit-vite 0%, sveltekit-app +4%.
- **More napi-rs threads**: `TOKIO_WORKER_THREADS=2` astro-app +10-15%, `=4` +11% for a
  vite-react-counter run without its dev cache (Vite's optimizer bundling); `RAYON_NUM_THREADS=4`
  +3%; `TOKIO_WORKER_THREADS=1` and `RAYON_NUM_THREADS=1` change nothing (they are the defaults:
  wasm32-wasi has no `available_parallelism`).
- **Answering for `/` in threads** (WASI's preopened directory: realpath, open and fstat of `/`, each
  a round trip, 60-200 ms while the parent is busy or blocked): no time gained in five A/Bs
  (−6% to +3%); the parent was not waiting for those threads. Likewise **answering for absent
  paths outside the project** (napi-rs loaders read `/usr/bin/ldd` to tell musl from glibc: an
  Angular CLI thread waited 0.6-1.2 s for its busy parent): angular-tasks −0%, astro-app +5%.
- **emnapi's strings through TextEncoder** (a source patch: one `encode` kept from napi-rs' length
  call to its copy, then one `set` into the module's memory, for long well-formed strings;
  `encodeInto` rejects shared memory): emnapi's string time on Astro's main thread 113 → 103 ms
  (`encode` itself 85 ms), runs unchanged (astro-app +0%, vite-react-counter −4%, lit-vite +3%).
- **Spares started differently**: all woken at once (lit-vite +7%, astro-app +3% against
  vite-react-counter −6%); one kept woken instead of two (+2%, +7%, +1%, 0%); replacements not woken
  (vite-react-counter +5%); spares booted by every program's runtime as it loads, on the full
  script (node-express +3-5%, from the next run's tab), or at the mount on the full script
  (node-express +13%); stub spares at the mount for every app (node-express +4%, n=8).

## Not done

- **esbuild-wasm off the program's thread.** The Angular CLI's esbuild runs its Go code in the
  runtime's thread (`worker: false`, so that Go's file calls reach the runtime's file system):
  ~1 s of a warm angular-tasks run's main thread. In a thread of its own, every file read would be
  a round trip to the busy parent, and the bundler and the Angular compiler plugin wait on each
  other.
- **Cheaper runtime boots for threads.** A runtime's boot in an idle tab is ~72 ms: 28 ms parsing
  the script and ~30 ms compiling the ~570 functions its top level runs (each parsed twice); a
  woken spare pays ~150 ms in a busy tab, 4-6 of them per Vite run. Compile hints for those
  functions, or a lighter runtime for WASI threads, would cut CPU (the runtime script is ADR
  0028's).
