# ADR NNNN: Compile less in the browser: a smaller runtime script, polyfills on first use

- Status: Accepted
- Date: 2026-10-23

## Context

Every run compiles the same code again: the runtime's script in each of its workers, the
node_modules code the runtime evaluates, and the dev tools' WebAssembly builds. A trace of a warm
`fixtures/lit-vite` run (2.9 s) had ~16 runtime workers (the program, its threads, spares) each
compiling the 2.8 MB runtime script, 65–135 ms each on a 4-core machine, ~1.3 s of CPU, and
evaluating node:crypto's polyfill at start-up. The obvious fix is a code cache. We measured what
Chromium offers (Chromium 141, Playwright 1.64):

| Code | Off-the-record context (each run) | Persistent profile |
|---|---|---|
| A page's classic script from a cacheable URL | no code cache | code cache (794 KB consumed on the 5th load) |
| A dedicated worker's script, `importScripts`, a module worker | no code cache | **no code cache** either |
| `eval` / `new Function` (how the runtime runs node_modules code) | none | none |
| WebAssembly | compiled per renderer process | (code cache only with `compileStreaming`, on disk) |

- **No code cache across runs.** Each run has its own browser context (its own network allowlist,
  ADR 0017), an off-the-record profile whose HTTP cache is in memory and which has no generated-code
  cache at all. Contexts do not share renderer processes either. A persistent profile would give a
  code cache only to main-thread scripts, and the runtime runs in workers; the page's own compile
  (~250 ms in a vite-react run) is ES modules, Playwright's evaluate scripts and, for Next.js,
  `eval`-wrapped modules. CDP's `Page.addCompilationCache` seeds only a frame's classic scripts.
- **WebAssembly is already compiled once per run.** V8 keeps compiled modules per process by their
  bytes (its native module cache), and a run's workers share one renderer process: in a warm
  `vite-react-counter` run, rolldown's module was compiled once (one `wasm.SyncCompile`) and its
  threads lazily compiled ~30 functions each against the main thread's 4,000.
- **What a worker compiles is the script it is given.** The runtime script compiled in 17 ms in an
  idle worker without crypto-browserify (1.2 MB) and napi-rs' WebAssembly runtime with emnapi
  (0.7 MB, ES modules compiled eagerly at the script's top level), against 42 ms with them.
  Most runtimes never load node:crypto or node:wasi.

## Decision

- **Polyfills that few runtimes need are runtime libraries** (`RUNTIME_LIBS` in
  `src/node-runtime/libs.ts`): crypto-browserify, browserify-zlib (zlib's JavaScript port) and
  WASI from `@tybys/wasm-util` are scripts of their own, `/__sandburg/node-<name>.js`, which a
  runtime loads with `importScripts` the first time a program requires `node:crypto`, `node:zlib`
  or `node:wasi`. The runtime script registers each of its CommonJS modules by path
  (`Symbol.for('sandburg.modules')`, by wrapping esbuild's `__commonJS` helper; the build fails if
  the helper changes), and a library's script takes every file the runtime script has from there, so
  both see one Buffer class, one stream module, and so on, as in one script. The runtime's service
  worker keeps them in memory as it does the runtime script; the static site and the runtime test
  harness serve them too. The runtime script's build fails if it would bundle one of these packages.
- **node:wasi takes only WASI**, not napi-rs' runtime: that one re-exports WASI from
  `@tybys/wasm-util`, and the rest is emnapi, which napi-rs packages load from their own
  node_modules.

## Consequences

- The runtime script is 2.8 MB → 0.86 MB. In a warm `vite-react-counter` run its compile per worker
  is 18–40 ms (65–143 ms before); a spare runtime woken in an idle tab runs its script in 192 ms
  instead of 499 ms; loading node:wasi in a thread costs 6 ms instead of 26 ms.
- Warm runs on an idle 4-core machine, interleaved, 4 rounds, against the parent of these changes:
  `lit-vite` 2.62 s → 2.02 s, `vite-react-counter` 3.65 s → 3.08 s, `next-app-router` 5.99 s →
  5.91 s (its time is in next dev's own code and its compile). Each change's own measurement is in
  its commit message. A 12-app batch in 3 tabs: 32.7 s → 30.8 s (3 rounds, the
  same answers). Peak memory of the renderers in a warm run: `lit-vite` 637 → 484 MB,
  `vite-react-counter` ~730 → ~580 MB, `next-app-router` 1,109 → 1,059 MB.
- The first `require('crypto')`, `require('zlib')` or `require('wasi')` in a runtime loads a script
  from the service worker (27 ms for crypto in the program's runtime of a Vite run, once).
- A host that serves the runtime itself (the static site, an embedder) must serve the libraries
  next to `node-worker.js`, or those built-ins fail to load.

## What did not help

Measured with interleaved warm runs (`scripts/bench.ts`, 4–6 rounds) unless noted:

- **Spares that run the compiled script instead of loading it again.** A woken spare compiles the
  runtime script twice (once on start, then `importScripts` to run it). Wrapping the runtime in a
  parenthesized function, which V8 compiles with the script, and calling it on the wake-up halved a
  woken spare's time in an idle tab (240 → 144 ms), but runs did not gain: lit-vite +2%,
  vite-react-counter +2% (6 rounds).
- **`//# allFunctionsCalledOnLoad`** (V8's compile hint) on the runtime script: honoured in workers,
  but compiling every function up front costs more than it saves (compile 14 → 49 ms, a woken spare
  190 → 207 ms).
- **V8 flags for the node_modules code the runtime evaluates**: `--parallel-compile-tasks-for-lazy`
  (vite-react-counter +19%, next-app-router +1%), `--no-lazy-eval` (+10%, +4%),
  `--no-flush-bytecode` (+7%, −1%). `--wasm-lazy-validation` (experimental) was within noise
  (−0%, −2%).
- **Fewer optimizing compiles of JavaScript.** As with WebAssembly (ADR 0027), V8's optimizing
  tiers are busy in the background: in a warm `next-app-router` trace, TurboFan 1.9 s and Maglev
  1.6 s of a pool thread's time. `--no-turbofan` cut the pool threads' CPU in a warm run by ~13%
  (2.04 → 1.77 s) but no time: `next-app-router` +0%, `vite-react-counter` −1%, and the 12-app
  batch in 3 tabs 30.3 s → 30.5 s. `--invocation-count-for-turbofan=12000` (4× the default):
  `next-app-router` −8% in one series, `vite-react-counter` +14% then +2%, `lit-vite` −1%.
- **assert, url (legacy API) and `util.parseArgs` as libraries too** (the runtime script 0.86 →
  0.65 MB; a woken spare 195 → 154 ms in an idle tab): a program's runtime requires assert and url
  as it starts, and its start got slower (`lit-vite` +6%, `vite-react-counter` start +6%).
- **The service worker fetching the libraries ahead**, with the runtime script: within noise
  (`lit-vite` +2%, 6 rounds; `vite-react-counter` −4%, `next-app-router` −4%, 4 rounds).
- **Minifying the runtime script** (whitespace, syntax, or all): compile 43 ms → 45–48 ms.
