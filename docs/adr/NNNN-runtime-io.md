# ADR NNNN: The runtime's requests to the host

- Status: Accepted
- Date: 2026-10-23

## Context

ADRs 0017 and 0025 cut what a runtime asks the host for; this one looked at what each request costs
and who waits for it. Counting and timing a runtime's synchronous requests per runtime and thread
(warm runs unless said otherwise, on a 4-core machine) showed:

- **Every request goes through Playwright.** The egress gateway routes the browser context
  (`context.route('**/*')`, ADR 0005), and a routed context sends each request through Playwright
  before it reaches the host, and disables the HTTP cache. A synchronous `XMLHttpRequest` from a
  worker for a small file took 5.6-6.6 ms routed and 2-4 ms not (measured on its own, 100 requests);
  in runs, ~7-15 ms while the host was busy. Cold runs make hundreds (a cold next dev: ~500).
- **Threads asked for what their parent had.** A thread or child process starts its own runtime,
  which asked for each installed file it loaded and only fetched the preload bundle after 40. Each of
  rolldown's WebAssembly threads in a Vite 8 run asked for the same 31 files: 250-370 ms per thread,
  while the bundler waits for them to start.
- **The bundles were fetched by the runtime, one after the other, after it had started**: a warm
  `next-app-router` run read its 27 MB dev-cache bundle and its 44 MB preload bundle in ~0.4 s.
- **A never-run install's first bundle is predicted** (ADR 0026), and the runtime waited for it before
  loading anything: 5.6 s in a cold `next-app-router` run, ~0.7 s for Vite.
- **Node API shims**: the buffer polyfill builds an array of a string's bytes to write it as UTF-16
  (es-module-lexer writes every module's source so) or to count its UTF-8 length, and sha.js copies
  hash input into each block one byte at a time (Vite hashes its lockfile and every response).

Resolution (stat, package.json, `exports`) was ~80 ms of a warm next dev run, most of it the bundle
read behind the first package.json: not worth a cache of its own.

## Decision

- **Threads and child processes read their parent's preload bundle in shared memory**: the parent
  copies it into a `SharedArrayBuffer` when it starts the first one (once), reads its own files there
  from then on, and passes it on in the init message.
- **Installed files over a WebSocket** (`/__sandburg/files`, `src/orchestrator/host-socket.ts`):
  WebSocket messages are not routed through Playwright. The host server accepts the socket from the
  sandbox's own origin only and answers GETs of installed files from the adapter, as over HTTP. The
  runtime's helper worker (ADR 0025's digest helper) holds the socket; the runtime posts it the
  request and waits on shared memory (~0.5 ms a request in the microbenchmark). Threads and child
  processes get a port to their parent's helper. Bodies over 1 MB (a 40 MB body took 4x as long over
  the socket as over HTTP), requests before the socket opens and after it closes go over HTTP.
- **The page downloads the preload and dev-cache bundles as it starts the worker**, into growable
  `SharedArrayBuffer`s passed in the init message; the runtime waits on that memory instead of
  requesting them, and the preload bundle is then shared with threads without a copy.
- **While that download is in progress, the runtime loads files one at a time** over the socket, and
  reads the bundle once it is there (what a cold run's first bundle wait was).
- **Shims**: UTF-16 writes and UTF-8 lengths of long strings without the intermediate array, and
  sha.js's block copy with `Uint8Array.prototype.set`.

## Consequences

- Interleaved A/B of each change, medians (each commit message has its numbers):
  - shared bundle, warm: `vite-react-counter` 5.06 → 3.99 s, `lit-vite` 3.74 → 2.72 s (n=4);
  - WebSocket, cold: start `vite-react-counter` 3.53 → 2.67 s, `lit-vite` 2.74 → 2.28 s,
    `node-express` 1.58 → 0.58 s (n=3);
  - page downloads, warm: `next-app-router` 7.84 → 7.32 s, `node-express` 1.16 → 1.09 s (n=4);
  - files while the first bundle is predicted, cold, start + ready: `vite-react-counter`
    4.14 → 3.91 s, `lit-vite` 3.22 → 2.95 s, `next-app-router` 19.89 → 18.94 s (n=3);
  - shims: CPU only, ~110 ms of a warm Vite run's runtime thread (UTF-16 writes 55 → 13 ms, UTF-8
    lengths 33 → 6 ms, the hash copy 38 ms → under 5), time unchanged.
- **The host server accepts WebSockets** at `/__sandburg/files`, from the sandbox's own origin.
- **The run report counts fewer requests** (`network … requests`): the runtime's file requests over
  the socket are not routed, so not counted; they were never egress.
- Memory: a runtime with threads holds its preload bundle once in shared memory (it held it once
  before, and each thread that loaded 40 files held its own); the page's downloads reserve 1 GiB of
  address space each (not memory) for the bundle to grow into.
- Tried and dropped: fetching the host's compile of a large written file (next dev's chunks) as soon
  as its digest is known, which left nothing to wait for but measured no faster
  (`next-app-router` warm 6.87 → 7.06 s, n=5); a `Uint8Array` subclass for Buffers instead of
  `Object.setPrototypeOf` (no difference in a microbenchmark).
