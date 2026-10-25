# ADR NNNN: The runtime as a module from Cache Storage: V8's code for every runtime of a run but the first

- Status: Accepted
- Date: 2026-10-25

## Context

ADR 0042 left the largest compile cost in the runtime's workers: Chromium gives a dedicated worker
no compiled code, and a run's browser context is off the record, with no code cache. This round asked
whether *how* code gets into V8 could change that. Measured in Chromium 153 (Chrome for Testing
153.0.8010.12) on an idle 4-core machine, with Chromium's tracing (`v8`,
`disabled-by-default-v8.compile`) and small pages that start workers in a fresh browser context:

- **Where a worker's script can get V8's code.** Classic scripts never do: neither a worker's own
  script nor `importScripts`, whether fetched from the network, from the HTTP cache, or answered by a
  service worker from Cache Storage, and not in a persistent profile either (a 1.5 MB script, six
  workers in a row: 120-140 ms each). A module worker's own script (`{ type: 'module' }`) gets its code
  produced but never used. Modules fetched with `import()` over plain HTTP get nothing (no code cache
  off the record). **A module a worker imports with `import()`, answered by the service worker from
  Cache Storage, does**: Chromium keeps V8's code beside the Cache Storage entry (which an off-the-record
  context keeps in memory, for the context's life), and later workers of the context use it: compile
  32 → 0.8 ms, the worker's whole start 127 → 24 ms for that 1.5 MB script.
- **What the code covers.** It is produced once the module has been evaluated, with every function
  that evaluation ran (a module that calls 300 functions as it runs: a later worker compiled 2 of them
  instead of 600). Functions called after the evaluation are not in it (a module that exports a
  function, called 5 ms to 1.5 s after the import: 603 compiles in every later worker).
- **Where it does not help.** `import()` costs ~1 ms per module even from Cache Storage (95 modules of
  0.36 MB: ~100 ms, against ~8 ms to `eval` them), modules are always strict, the stack frames of a
  module's functions name the module's URL, and `require` is synchronous while `import()` is not.
  Loading node_modules files as modules would mean importing, before the program starts, only large
  strict files the program is known to load (from its preload bundle), and the first runtime of a run
  would compile them anyway. Not done (see below).
- **What the runtime's own script costs.** Every runtime of a run compiles the runtime's 0.86 MB
  script: the program's, its spares (ADR 0028), worker threads (rolldown's and oxc's, ADR 0038) and
  child processes. In a warm `vite-react-counter` run, 6-8 runtimes; each spare that became a thread
  spent ~100 ms evaluating the script (`v8.compile` 20-25 ms, ~650 lazy compiles, `ParseProgram`
  47-64 ms, `PreParse` 46-64 ms, plus `CollectSourcePositions` 40-70 ms under tracing).

## Decision

- **The runtime's script is a module** (`src/node-runtime/runtime-module.ts`). The host serves
  `/__sandburg/node-worker.js` as a small classic script that imports the runtime's script, unchanged,
  as a module from `/__sandburg/runtime/<sha-256 of its text>.mjs`; the host answers that path only for
  the current text's digest, and only to GET or HEAD. The classic script holds the worker's messages
  until the module has been evaluated, then hands them on in order, with their ports (the runtime hides
  the worker's globals as it starts, so the script keeps its own references). A module that does not
  load fails the worker as a script that does not load did: the error is rethrown as the worker's.
  Spares (`node-spare.js`) load the classic script with `importScripts` as before.
- **The service worker answers the module from Cache Storage** (`sandburg-runtime`, by its URL): the
  first request fetches it from the host and stores it there; every answer comes from the cache, the
  one source for which Chromium keeps V8's code for a worker's script. The runtime's script was
  already strict (`"use strict"` opened it), declares no globals, and its stack frames keep naming its
  URL; it still loads its libraries with `importScripts` (the worker stays a classic worker).
- **The host page registers the service worker as it loads**, before it starts the program's runtime,
  instead of when the app starts: a dedicated worker is a service worker's client by its own URL
  (whether or not its page is one) if the registration is active when it starts. The runtime the page
  prepares as it loads (ADR 0031) is so the first runtime of the context, and the run's spares,
  threads and child processes start from its code. The page itself becomes the service worker's
  client when it gives the service worker an app's port, as before (the service worker claims it then,
  no longer as it activates): until an app starts, the page's own requests go to the host. A session's
  next tab is opened while the current run runs (ADR 0031), so the code is produced before the next run
  starts. Without a service worker, a runtime compiles its script as before.
- **A host that serves the runtime's script itself as `node-worker.js`** (the static deployment,
  `scripts/pages/build.ts`) works as before: the runtime is a classic script there.

## Consequences

- **In a warm `vite-react-counter` run** (tracing, one run each), a spare that became a thread:
  lazy compiles ~650 → ~430, `ParseProgram` 47-64 → 13-15 ms, `PreParse` 46-64 → 10-12 ms,
  `CollectSourcePositions` 40-70 → ~3 ms, and the module itself 20-25 → 2 ms (deserialized). The
  program's own runtime is the context's first: it compiles as before, at page load of the spare tab.
- **Interleaved warm A/B** against origin/quality-structure (`scripts/bench.ts`, both sides as refs,
  5 rounds, medians of the time to the result; each side's `.sandburg/` carried over between rounds):

  | Fixture | Total | Start | Ready |
  |---|---|---|---|
  | vite-react-counter | 1.83 → 1.76 s (−4%) | 0.78 → 0.76 s | 0.36 → 0.34 s |
  | lit-vite | 1.34 → 1.39 s (+4%) | 0.54 → 0.54 s | 0.29 → 0.30 s |
  | sveltekit-app | 3.48 → 3.37 s (−3%) | 1.44 → 1.34 s (−7%) | 1.08 → 1.08 s |
  | astro-app | 4.33 → 4.04 s (−7%) | 1.28 → 1.20 s (−6%) | 2.11 → 1.97 s (−6%) |

  An earlier series of 3 rounds (with next-app-router, 5.34 → 5.53 s, +3%; `lit-vite` −10%,
  `vite-react-counter` +7%) moved the other way for the two smallest fixtures: single rounds vary by
  ±0.2 s, and a run's other runtimes are mostly off its critical path. The saving is CPU.
- **A batch** (`scripts/bench-batch.ts`, 12 corpus apps of seed 1, 3 tabs, warm, 3 rounds): wall
  24.43 → 24.17 s (−1%), per-app median 5.81 → 5.79 s, **the renderers' CPU 62.8 → 61.0 s (−3%)**,
  **peak memory of the renderers 3157 → 2870 MB (−9%)** (every head round below every base round:
  2751-2935 against 3068-3165 MB). The same 10 of 12 apps passed on both sides.
- **Behaviour changes:**
  - The host serves `/__sandburg/node-worker.js` as a 0.6 KB classic script and the runtime at
    `/__sandburg/runtime/<digest>.mjs`.
  - The host page registers its service worker as it loads, not when the app starts, and starts the
    program's runtime once it is active (the runtime is not needed before the install ends; a run
    that takes the page before then starts its own, as when one failed to load). The service worker
    claims the page when the app's port arrives, not as it activates.
  - Each run's browser context keeps the runtime's module and its code in Cache Storage
    (`sandburg-runtime`, ~0.9 MB and its code) for the context's life.
  - A runtime evaluates its script after a task more than before (the module's import), and messages
    sent to it before then are delivered as synthetic events (`isTrusted` false), in order.

## Security

- **Nothing crosses a browser context.** Cache Storage and V8's code beside it belong to the context
  (off the record: in memory, gone with it) and to the origin: another run's or another sandbox's
  runtime never sees them (`test/runtime/runtime-module.test.ts`: a runtime in another context compiles
  the module again).
- **What is cached is the host's code, under the digest of its text.** The host answers
  `/__sandburg/runtime/<digest>.mjs` only for the digest of the runtime it built, only to GET and HEAD
  (`test/unit/node-routes.test.ts`: another digest, another spelling of it, other methods), and only to
  the sandbox's own pages, as every host route (`test/unit/host-server.test.ts`: requests from another
  site are refused before the adapter sees them, the module's path included). The module is the same for
  every sandbox and was served to every sandbox before, as `node-worker.js`.
- **An app can write its own origin's Cache Storage**, and so replace the module its later runtimes
  import. That is code it could run anyway: the runtime is not a boundary against the app it runs (the
  app's code runs in the same workers, and the app can register a service worker of its own). Chromium
  drops the code of a replaced entry: V8's code is never used for other text under the URL, even one of
  the same length (`test/runtime/runtime-module.test.ts`: a planted entry of the same length is compiled
  and runs as itself).
- **The worker's origin, CSP and isolation are unchanged**: the module is same-origin, imported by the
  worker's own script; the host page and its workers keep their cross-origin isolation headers.

## What did not help

- **node_modules files as modules.** `import()` costs ~1 ms per module from Cache Storage (95 modules:
  ~100 ms against ~8 ms of `eval`), and only a run's second runtime of a file would gain; a program's
  runtime evaluates each node_modules file once.
- **Compiling large files ahead in helper workers**, eagerly (`//# allFunctionsCalledOnLoad`), for the
  program's runtime to import with their code: Vite's 1.45 MB chunk takes 108-133 ms to compile in a
  helper and 18 ms to import with its code, against 31 ms for the program's runtime to `eval` it (its
  top level; the functions it runs compile later). The largest file bounds the critical path, `require`
  cannot wait for an import, and modules would have to be strict and name their files in stacks.
- **A module worker** (`new Worker(url, { type: 'module' })`): its own script's code is produced but
  never used; and the runtime needs `importScripts` for its libraries.
- **Network initiators** as the cause of the source-position collections under tracing: the first
  synchronous request of a worker with a large script costs ~5 ms more than the next, not 30, and no
  stack is formatted in a warm Vite run's program runtime (a `prepareStackTrace` hook saw none);
  `CollectSourcePositions` appears to be tracing's own cost.

## Not done

- **The functions a runtime runs after its script** (its `init`, mount, thread setup): ~430 lazy
  compiles in each thread of a Vite run remain. V8's per-function compile hints on the module would
  put them in the code (only the first runtime of a run would compile them up front, ADR 0042's cost);
  they need the functions' positions in each build of the script.
- **The runtime's libraries** (`node-wasi.js`, 0.1 MB, in every WebAssembly thread) are still classic
  scripts loaded with `importScripts`, compiled in each thread (2-5 ms).
- **Compiling the program's node_modules while the install runs**: the program's runtime waits idle for
  the install (0.2-0.5 s of a warm run) and then compiles the top level of every file it loads (~0.1 s
  of `ParseProgram` in a warm Vite run, ~0.4 s in Next.js under tracing). Knowing the install early (the
  project's last install) would let it compile them ahead, and start the preload bundle's download.
