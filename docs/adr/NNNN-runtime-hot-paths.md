# ADR NNNN: The runtime's own hot paths

- Status: Accepted
- Date: 2026-10-25

## Context

Once installs and caches are warm, a run's time is mostly the dev server running inside the runtime.
This round looked at the runtime's own share of that (`src/node-runtime`: its built-ins, loader,
threads), as opposed to the app's, the framework's and the compilers'. CPU profiles of every browser
thread in warm runs (`scripts/profile.ts`, a 4-core machine) of `vite-react-counter`, `lit-vite`,
`sveltekit-app`, `astro-app`, `nuxt-app` and `next-app-router`, plus traces of timers, of each
thread's file system calls (user-timing marks around `RemoteVfs.call`) and of an edit loop, ranked it:

- **Loading polyfills a program does not use.** Vite requires `node:zlib` and `node:crypto` as it
  starts; each was a runtime library (ADR 0028) loaded with `importScripts` on the program's thread:
  in a warm `vite-react-counter` run 188 ms for zlib (Vite does not use it in dev) and 71 ms for
  crypto (1.2 MB, for hashes only); `astro-app` 88 ms for crypto.
- **UTF-8 encoding of long strings.** `Buffer.from(string)` went through `TextEncoder.encode`,
  which in Chromium encodes into memory of its own and copies it out: ~3.3 ms per MB of ASCII,
  against ~1.2 ms for `encodeInto` into memory of the right size. A dev server ends most responses
  with a string (`res.end(code)`), and Vite encodes each source map before base64: 183 ms of a warm
  `vite-react-counter` run's program thread, 158 ms of `astro-app`'s.
- **Hashing in JavaScript.** sha.js and md5.js (under crypto-browserify) read each 32-bit word with
  `Buffer.readInt32BE`: Vite hashes every response for its ETag (SHA-1) and its lockfile (SHA-256),
  45 ms of hashing in a warm `vite-react-counter` run, 33 ms in `astro-app`.
- **Threads waiting for a busy or blocked parent.** A thread's file system calls run on its parent's
  (ADR 0012; installed packages aside, ADR 0038). Each thread waited 100-400 ms in total, most of it
  in a few calls: rolldown's WASI `realpath('/')` from a thread whose parent was blocked on that
  thread waited the full 200 ms of `PARENT_PATIENCE_MS` before reading its snapshot, in
  `sveltekit-app` and `astro-app`; `nuxt-app`'s threads waited 450 ms in all, `sveltekit-app`'s 300.
- **UTF-16 writes** (es-module-lexer writes each module's source into its WebAssembly memory): a
  byte at a time, 54-62 ms of a warm `astro-app` run.
- **What did not show:** timers (the runtime's own short timers fire on time; Chromium's 4 ms clamp
  of nested timers does not apply to them in these runs), the HTTP server's per-request objects, path
  normalisation (11-15 ms), and fs errors (async ones are already made without stack frames). An
  edit's time to render (~85 ms in `vite-react-counter`, `scripts/edit-loop.ts`) is ~24 ms in the
  runtime (the watcher, Vite's transform and its WebSocket message); the rest is React Refresh's
  debounce in the page and Playwright's polling.

## Decision

- **node:crypto's common hashes in the runtime's script** (`builtins/hash.ts`): MD5, SHA-1, SHA-224,
  SHA-256, SHA-384 and SHA-512, as `createHash`, `createHmac` and `crypto.hash`, with Node's
  aliases (`RSA-SHA256`, `sha-256`, case-insensitive), `copy()`, streams (they are Transforms),
  every output encoding, and Node's errors for a digest called twice, a bad input type and an
  unknown algorithm. Blocks are read from the input in place. `randomBytes`, `randomFill` and
  `randomFillSync` are `crypto.getRandomValues`. crypto-browserify's other members (ciphers, signing,
  pbkdf2, Diffie-Hellman, other hashes such as RIPEMD-160) are on the module as getters that load
  the library the first time one is read, then hold its value (`lazyMember` in `worker.ts`).
- **node:zlib loads browserify-zlib on first use the same way**: the native streams and callbacks
  (ADR 0025's CompressionStream ones), the brotli stubs, `crc32` and zlib's constants are the
  runtime's; the synchronous functions, the classes and a stream that is flushed early (which
  becomes the JavaScript port) load the library. The lists of what each library exports are in
  `libs.ts`, and a unit test checks them against the libraries.
- **Long strings' UTF-8 with `encodeInto`**: a string of 32 K characters or more is encoded into its
  length and an eighth; what does not fit (text that is mostly not ASCII) is encoded on its own and
  joined. Shorter strings stay as they were.
- **Threads answer reads of unchanged project files from their snapshot.** A thread's snapshot
  (`projectSnapshot`) now holds the parent's stats and directory listings of everything it covers
  (the project's files outside caches, build output and node_modules, and the directories above the
  project), and a flag in shared memory that the parent raises once anything it covers changes: a
  file written, made, removed or renamed there, or the listing of a directory there. Until then a
  thread answers `exists`, `stat`, `read` and `readdir` of those paths itself, with the parent's
  answers (the same stats, listings, bytes and errors), without a round trip. A thread hands its
  own snapshot to the threads it starts while it is exact. Paths it does not cover (caches the
  parent writes, `/tmp`, a file over 4 MB) are asked as before.
- **UTF-16 writes a code unit per store** where the target is 2-byte aligned (es-module-lexer's
  memory is).

## Consequences

- The branch against origin/main (`scripts/bench.ts`, both sides as refs, interleaved, warm, 3
  rounds, medians; the branch's worktree was new, origin/main's had run before):

  | Fixture | Total | Start | Ready |
  |---|---|---|---|
  | vite-react-counter | 2.04 s → 1.91 s (−6%) | 0.82 → 0.75 s | 0.46 → 0.42 s |
  | lit-vite | 1.55 s → 1.40 s (−9%) | 0.65 → 0.55 s | 0.31 → 0.24 s |
  | astro-app | 5.84 s → 5.58 s (−4%) | 1.50 → 1.29 s | 3.41 → 3.32 s |
  | sveltekit-app | 4.17 s → 4.27 s (+2%) | 1.51 → 1.49 s | 1.42 → 1.47 s |
  | nuxt-app | 7.90 s → 8.07 s (+2%) | 0.80 → 0.85 s | 5.19 → 5.43 s |
  | next-app-router | 5.46 s → 5.40 s (−1%) | 1.26 → 1.18 s | 2.80 → 2.93 s |
  | node-express | 0.72 s → 0.66 s (−8%) | 0.21 → 0.13 s | 0.09 → 0.10 s |

  `sveltekit-app` and `nuxt-app` again, 4 rounds, both worktrees warm: 4.33 → 4.09 s (−5%) and
  7.58 → 7.44 s (−2%); neither had moved for any change on its own. Cold (3 rounds):
  `vite-react-counter` 6.83 → 6.80 s, `lit-vite` 5.44 → 5.58 s, within noise (their time is the
  install's). node-express's start is the crypto and zlib libraries it no longer loads (Express
  hashes ETags).
- Per change (each commit message has its numbers):
  - crypto and zlib on first use: the program's start in warm runs, 4 rounds, against main:
    `vite-react-counter` 0.80 → 0.73 s, `lit-vite` 0.61 → 0.52 s, `astro-app` 1.41 → 1.35 s,
    `sveltekit-app` 1.54 → 1.47 s (with the UTF-8 change). Totals moved less (−3% to +1%): in Vite's
    start, the program's thread also waits for rolldown's threads and the preload bundle, and
    `lit-vite`'s ready grew by what its start lost (0.22 → 0.29 s), the dev server's work after
    listening queued behind the first request.
  - hashes: 2 MB in one update, in the runtime: SHA-1 37.5 → 11.3 ms, SHA-256 38 → 13 ms, MD5 36 →
    7.8 ms, SHA-512 95 → 76 ms; a warm `vite-react-counter` run's hashing 45 → 25 ms of its thread,
    and crypto-browserify (71 ms) not loaded.
  - UTF-8: `Buffer.from` of 1 MB of ASCII 3.3 → 1.2 ms (no slower for CJK text); a warm
    `vite-react-counter` run's `Buffer.from` 183 → 46 ms of the program's thread, `astro-app`'s
    158 → 80 ms.
  - threads: the time threads waited for their parent's answers in a warm run, all threads:
    `sveltekit-app` 300 → 25 ms, `nuxt-app` 451 → 99 ms, `astro-app` 281 → 47 ms,
    `vite-react-counter` 110 → 5 ms; no 200 ms waits left. Totals (4 rounds): `sveltekit-app`
    4.05 → 4.01 s, `nuxt-app` 7.59 → 7.52 s, `astro-app` 5.56 → 5.53 s, `vite-react-counter`
    1.88 → 1.82 s, within noise.
  - UTF-16: 1.1 M characters 3.5 → 2.4 ms in a worker; in warm `astro-app` profiles 54-62 ms
    before, 3.4 ms after (one profile).
- **Behaviour:**
  - `crypto.createHash` and `createHmac` for MD5 and SHA-1/2 are the runtime's: the same digests.
    An unknown algorithm now throws Node's `Digest method not supported` (and `Invalid digest`,
    `ERR_CRYPTO_INVALID_DIGEST`, for an HMAC) instead of crypto-browserify's message.
    `crypto.getHashes()` lists `sha224` too.
  - `require('crypto')` and `require('zlib')` no longer load their libraries; the first use of a
    member only they have does (once per runtime, as the `require` did). Their members are
    enumerable as before; until first read, those from the libraries are accessors.
  - A thread may answer for a project file it read before its parent changed it only until the
    change: the parent raises the flag as it applies the change, before a thread's next call returns.
- Memory: a snapshot keeps a stat per project file and a listing per directory beside the bytes it
  held already.

## Security

- No new route, socket, or cache shared across runs. Everything here is inside one runtime and its
  own threads, which share one run's file system already.
- The snapshot's flag is a `SharedArrayBuffer` between a runtime and the threads it starts; the
  parent only ever raises it. A thread that ignored it could read only what its own snapshot holds:
  the run's own project files, which it can read anyway.
- The hashes are pure functions of their input; nothing about them reaches the host. Random bytes
  come from `crypto.getRandomValues`, as crypto-browserify's did.

## What did not help

- **Coalescing small writes to the native zlib streams** into 64 KB: gzip of 2 MB in 100-byte writes
  115 → 33 ms in a microbenchmark, but nothing in the fixtures (warm `next-app-router`, whose webpack
  cache goes through these streams: the native transform's time 306-324 ms before and 286-326 ms
  after, totals 5.22 → 5.12 s and `next-pages-router` 3.71 → 3.78 s, 4 rounds): its chunks are
  large already. Dropped.
- **Timers that avoid Chromium's 4 ms clamp of nested timers:** a trace of every timer's install and
  fire showed the runtime's own short timers (1 ms) firing on time; the late ones are the page's.
- **A thread "busy" in WebAssembly for seconds** while everything else is idle (rolldown's, 1.3 s in
  one function): that function is a futex wait (`memory.atomic.wait32`); V8's profiler counts a
  thread blocked there as running.

## Not done

- **The preload bundle's download** is 80-200 ms of a warm run's start on the program's thread
  (`prefetchedBody`: the runtime waits for the page's download, ADR 0029): the largest wait left in
  the runtime's start. Reading the files it needs first as the rest arrives would cut it.
- **Next.js' dev cache readback** in a run whose cache changed: the page reads the whole webpack
  cache back every 250 ms until it settles (`dispose` in `adapters/node/browser.ts`), and the runtime
  encodes each pack in base64 for it: ~2 s of a host page's main thread and ~0.9 s of the runtime's in
  a first warm `next-app-router` run. Binary transfers (and comparing digests) would cut both.
- **Authority after a covered write:** once a covered file changes, a thread asks its parent for every
  covered path again. A log of the changed paths in shared memory would keep the rest answered locally
  (`nuxt-app` writes in the project as it starts).
- **Hashing in WebAssembly** (SIMD for SHA-256's message schedule): the JavaScript hashes run at
  ~150-180 MB/s; a response's ETag is now ~0.01 ms per KB, and the remaining hashing ~25 ms of a run.
