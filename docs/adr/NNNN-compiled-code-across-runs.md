# ADR NNNN: Compiled code across runs: axe-core's from V8, the host's own from disk

- Status: Accepted
- Date: 2026-10-25

## Context

Every run is its own browser context (its own origin, network allowlist and renderer processes,
ADR 0017), an off-the-record profile with no code cache, so V8 compiles the same code in every run.
This round measured where (Chromium 153, warm runs on an idle 4-core machine; V8's
`--log-function-events` per isolate and Chromium tracing with `disabled-by-default-v8.compile`):

- **The program's runtime thread** of a warm `vite-react-counter` run spends ~345 ms in V8's parser
  and compiler: ~200 ms for Vite's 1.45 MB main chunk (its top level ~75 ms, lazy compiles of the
  functions it runs), ~70 ms for the runtime's script (0.86 MB), ~50 ms for crypto-browserify
  (1.2 MB, `node-crypto.js`, loaded because Vite imports `node:crypto` for `createHash`), the rest
  for other modules. `next-app-router`'s runtime thread: 945 ms of lazy compiles (14,600 functions)
  and 370 ms parsing 1,575 evaluated sources. Each of the run's other runtimes (rolldown's threads,
  woken spares) spends 60-130 ms on the runtime's script.
- **The page's main thread** compiles axe-core (650 KB) for every run's accessibility check: its top
  level streams off the main thread, but the functions its first scan runs compile lazily on it
  (load and first scan: 134 ms in an idle page, 69 ms with compiled code); Playwright's injected
  scripts, ~60-90 ms per run, are evaluated by Playwright (no URL, nothing to cache).
- **The host** builds the runtime's script and its four libraries with esbuild in every process
  (110 ms, and 280-340 ms for the libraries, beside the install), and Node compiles Sandburg's
  modules and Playwright's on every start (importing the CLI: 557 ms, 455 ms from Node's compile
  cache).

What Chromium can reuse across contexts (ADR 0028 measured Chromium 141; this round 153):

- **A code cache only for a page's classic scripts.** Contexts share no code, and an off-the-record
  profile keeps none. DevTools can hand a page compiled code for a classic script by its URL
  (`Page.addCompilationCache`) and produce it (`Page.produceCompilationCache`, eagerly: every function
  compiled), but Chromium consults it only for a script it compiles on the main thread: not for one it
  streams (every external script over 30 KB in UTF-8 or Latin-1), not for module scripts, worker
  scripts, `importScripts`, `eval` or Playwright's evaluations.
- **Nothing for workers**, where the runtime and everything it evaluates run.

## Decision

- **axe-core with its compiled code** (`orchestrator/code-cache.ts`).
  - A session produces V8's code for axe-core once, eagerly, in a browser context of its own that
    loads nothing but the host's copy of the script (answered by the context's routes, no network),
    and keeps it in `.sandburg/code-cache/`, keyed by a digest of the script's text, the browser's
    version and its launch flags. An entry carries a digest of its bytes, checked on read (V8 does not
    check the payload of code it is given); a damaged one is produced again.
  - The host serves axe-core a second time as a classic script in UTF-16 (`/__sandburg/axe.classic.js`),
    an encoding Chromium does not stream, so that the compiled code applies.
  - A tab gets the code as its host page loads, before its run (sending 1.7 MB over DevTools takes
    ~40 ms), in a DevTools session of its own that holds it for that URL only, and closes once
    axe-core has loaded. The checks load axe-core from there beside the screenshot and the
    accessibility snapshot, as before; without code (the first run of a session that has none on
    disk yet, a page with a Content-Security-Policy), as before.
- **node:crypto without crypto-browserify for what most programs use** (`node-runtime/worker.ts`,
  `libs.ts`). A new runtime library, `node-hash.js` (140 KB: create-hash, create-hmac, randombytes,
  randomfill), gives node:crypto its hashes, HMACs and random bytes; crypto-browserify's other
  exports (ciphers, signatures, key exchange, pbkdf2) are getters that load `node-crypto.js` the first
  time one is read. Vite, Next.js and most dev tools only hash.
- **The runtime's scripts from disk** (`node-runtime/bundle-cache.ts`). esbuild's output for the
  runtime's script and its libraries is kept in `.sandburg/bundles/` with the digest of every file the
  build read (its metafile), of the package.json of each package those come from, and of the build's
  own code (`bundle.ts`, `libs.ts`); a process uses it while all of them are unchanged, else builds
  and replaces it.
- **The CLI's modules from V8's code cache**: `bin/sandburg.js` enables Node's compile cache in
  `.sandburg/node-compile-cache` (or `$NODE_COMPILE_CACHE`), not in the temporary directory, which
  other users of a machine share. The npm worker, which enabled it there already (Node 22 does not
  pass the main thread's directory on to workers), uses the same directory beside the installs.

## Consequences

- The branch against origin/main (`scripts/bench.ts`, both sides as refs, interleaved, warm, 3
  rounds, medians of the time to the result; each side's `.sandburg/` carried over between rounds,
  and a warm run is a session's second, so the host's caches below do not show here):

  | Fixture | Total | Start | Ready | Checks |
  |---|---|---|---|---|
  | vite-react-counter | 1.71 → 1.58 s (−8%) | 0.66 → 0.63 s | 0.39 → 0.42 s | 0.33 → 0.28 s (−14%) |
  | lit-vite | 1.15 → 1.13 s (−2%) | 0.52 → 0.49 s | 0.18 → 0.21 s | 0.23 → 0.19 s (−17%) |
  | sveltekit-app | 3.41 → 3.47 s (+2%) | 1.28 → 1.37 s | 1.06 → 1.08 s | 0.61 → 0.57 s (−7%) |
  | astro-app | 4.21 → 4.34 s (+3%) | 1.18 → 1.20 s | 2.23 → 2.37 s | 0.45 → 0.42 s (−8%) |
  | next-app-router | 4.64 → 4.64 s (+0%) | 1.05 → 0.96 s | 2.57 → 2.54 s | 0.55 → 0.53 s (−4%) |

  The checks are shorter in every fixture. The start and ready phases move by ±0.1 s between A/Bs of
  the same revisions (the single changes' A/Bs at n=4 are in their commit messages: node:crypto's
  start −6 to −11% for vite-react-counter, lit-vite and next-app-router). None of the five loads
  crypto-browserify any more (only `node-hash.js`).
- **A `sandburg run` from the CLI**, end to end, origin/main and the branch each in its own worktree
  (its own `.sandburg/`, warm), interleaved, 7 rounds, medians: `lit-vite` 3.06 → 2.70 s (−12%),
  `node-express` 2.30 → 1.84 s (−20%). Of that, the runtime's scripts from disk: lit-vite 2.60 →
  2.39 s on their own (n=7); Node's compile cache: 2.55 → 2.47 s (n=6), importing the CLI 557 →
  455 ms.
- **A batch** (`scripts/bench-batch.ts`, 12 corpus apps of seed 1, 3 tabs, warm, 3 rounds): wall
  19.63 → 18.96 s (−3%), per-app median 4.83 → 4.60 s (−5%), the renderers' CPU 49.7 → 48.4 s, the
  host's esbuild 0.9 → 0.1 s, Chromium's browser process 6.2 → 6.5 s (sending each tab axe-core's
  code). Peak memory of the renderers 2.98 → 3.16 GB, within the rounds' spread (2.94-3.07 against
  3.00-3.21 GB); a page's JavaScript heap after axe-core's scan is 2.9 MB without its code and
  3.3 MB with it (every function compiled).
- **Behaviour changes:**
  - The host serves `/__sandburg/axe.classic.js` (axe-core in UTF-16) besides `/__sandburg/axe.js`.
    A run's axe-core check loads it as a classic script in the app's frame, removed from the
    document once it has run (as the module import left nothing in it).
  - A session opens one more browser context, once, to produce axe-core's code (~0.2 s of CPU) when
    `.sandburg/code-cache` has none for its browser; `codeCacheDir: null` keeps it in memory only.
    Each tab gets a DevTools session of its own until axe-core has loaded.
  - node:crypto's hashes, HMACs and random bytes come from `/__sandburg/node-hash.js`; the first read
    of any other export loads `/__sandburg/node-crypto.js`. A host that serves the runtime itself
    serves `node-hash.js` next to `node-worker.js` (the static site does), or `require('crypto')`
    fails.
  - `.sandburg/` holds `code-cache/` (1.3 MB), `bundles/` (2.6 MB) and `node-compile-cache/`
    (1.6 MB) besides the other caches. A new entry replaces the script's entries for other builds
    (another browser, flags, or version of Sandburg).

## Security

- **The shared code is the host's, produced from the host's own copy of axe-core**, in a browser
  context that loads nothing else: no sandbox origin, no app, no egress. It is keyed by a digest of
  that text (and the browser's version and flags); nothing a run does produces, changes or chooses
  it. Each run's page gets a copy over DevTools: data goes from the host to the renderer only, so it
  is no channel between sandboxes.
- **The code applies to one URL, for one load**: the host's classic copy at the sandbox's own origin,
  in a DevTools session that is closed once axe-core has loaded. The page sees no more than before: it
  can load axe-core from its origin already.
- **An app could answer that URL itself** (a service worker of its own) with a script of the same
  length: V8 checks the code against the script's length and its own version and flags, not its
  text, so that app's frame would run axe-core instead of the app's script, or crash its own
  renderer. Neither reaches another sandbox or the host: it is code the app could load anyway, in its
  own renderer.
- **On disk**, the entries live in `.sandburg/`, with the host's other caches (the package store,
  compiled node_modules files): a digest guards against a damaged or truncated file (V8 rejects code
  whose header does not fit, but takes any payload behind a header that does: a page given such
  bytes in a trial crashed, its own renderer only). Writing there needs the host's own access.
- **The bundle cache** keeps host code only (the runtime and its libraries, built from Sandburg's
  sources and its dependencies), keyed by the digests of every file the build read; no app's files
  are among them.
- **The compile cache** holds V8's code for the host's own modules (Sandburg's, Playwright's, npm's),
  in `.sandburg/`: the npm worker's was in `/tmp/node-compile-cache`, which another user of the
  machine could create first and fill.
- Tests: `test/runtime/code-cache.test.ts` (the code is used by another context for its URL only and
  not after the load; code that does not fit is not used; damaged, truncated and junk entries; the
  disk key), `test/unit/bundle-cache.test.ts` (changed inputs, package versions, salt, damaged
  entries, an unwritable directory), `test/runtime/core.test.ts` (node:crypto loads crypto-browserify
  only when needed).

## What did not help

- **V8's per-function compile hints** (`//# functionsCalledOnLoad=…`, honoured with
  `--js-flags=--compile-hints-magic`, in workers too: a runtime's boot went from 249 lazy compiles to
  1) on the runtime's script, for the ~400 functions most runtimes of a Vite run executed: the start
  phase of `vite-react-counter` 0.69 → 0.75 s (n=6). Every spare and thread compiled them all at
  boot. ADR 0028 found the same for `//# allFunctionsCalledOnLoad`. V8 ignores the hints in `eval`,
  which is how the runtime evaluates node_modules.
- **axe-core's code sent as the checks start** (not with the tab): `Page.addCompilationCache` with
  1.7 MB takes ~40 ms, and the checks phase did not change. **Loading axe-core after the artifacts**:
  the screenshot got faster, axe-core's check slower by more, the phase the same.
- **Non-streamed scripts without code**: blob URLs and inline scripts are streamed or get no code
  (DevTools produces and applies it only for external scripts).
- **The page checks' runtime with its compiled code** (`--checks-in page`, 350 KB): its load overlaps
  the artifacts; the checks phase of `lit-vite` 141 → 142 ms (n=8).

## Not done

- **Compiled code for the runtime's workers.** Chromium has no way to give a dedicated worker
  compiled code (DevTools' compilation cache is the page agent's), and an off-the-record context keeps
  none. Node_modules code evaluated in the runtime (Vite's chunk, Next.js' server code) is the largest
  compile cost left: 0.35 s of a Vite run's runtime thread, 1.3 s of Next.js'.
- **Compiling large ES modules off the runtime's thread**: a module script imported from a URL (or a
  blob) is streamed and compiled on a background thread; but `require` is synchronous, and the import
  completes only in a later task, after the code that required it ran.
- **Lazy module bodies in the runtime's script**: 36% of its bytes (assert, qs, object-inspect,
  readable-stream's pipeline and operators, the SQLite and child-process built-ins) ran in none of a
  Vite run's 13 runtimes, but V8 pre-parses them in each: ~5-8 ms a boot, as strings evaluated on
  first use (or more runtime libraries; ADR 0028 tried those for modules a program's runtime loads
  at start, and lost).
