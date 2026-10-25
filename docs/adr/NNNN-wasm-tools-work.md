# ADR NNNN: The WebAssembly tools' work: esbuild's transforms on the host, Vite's config bundle kept

- Status: Accepted
- Date: 2026-10-25

## Context

A run's program runs the WebAssembly builds of its native tools on the runtime's one busy thread:
esbuild (Go), SWC, rolldown and oxc, lightningcss, Tailwind's oxide. CPU profiles of every browser
thread (`scripts/profile.ts`, a 4-core machine), user-timing marks around every call into the
esbuild shim, and microbenchmarks of the tools in Node showed where their time goes now:

- **esbuild's Go code is the slowest of them, 10-15 times native.** A first run of
  `corpus/012-vite-react` (Vite 6, lucide-react) spent 4.8 s of its runtime thread in esbuild's
  WebAssembly build, `corpus/003-vite-react` (Vite 6, lucide-react, React Router, Tailwind v4) 5.3 s
  of a 7.0 s ready phase: Vite's dependency pre-bundle. The same pre-bundle (1,550 inputs with their
  source maps) took 3.2-4.5 s with esbuild-wasm in Node and 0.26-0.32 s with native esbuild. In a
  warm `angular-tasks` run the Angular CLI's esbuild was 0.79 s of the runtime's thread.
- **A warm Vite 5-7 run starts esbuild to bundle its config, then transforms one module at a time.**
  Marks in a warm `corpus/012-vite-react` run: esbuild's start 55-73 ms, the bundle of
  `vite.config.ts` 288-337 ms (that start included: Go's runtime and cold code), then each
  TypeScript/JSX module's transform 18-110 ms, one after another (Go's service is one thread).
  Natively a transform of such a module takes 1-2 ms. Vite 6 is two thirds of `scripts/corpus`'s apps.
- **Elsewhere the tools' share is small.** A warm Next.js App Router run with its seed (Tailwind v4):
  SWC 257 ms and Tailwind's oxide 163 ms of the runtime's thread; Vite 8 fixtures: rolldown and oxc
  120-630 ms (Nuxt); emnapi's JavaScript side ~200 ms of an Astro run, spread over many small calls.
  A seedless Next.js run spends 1.4-3.4 s in SWC, but only a set of versions' first app and its
  seed run are seedless.
- **The tools' builds** (their `target_features`): rolldown has SIMD, atomics and bulk memory; SWC's
  (`@next/swc-wasm-nodejs`) and lightningcss-wasm have neither SIMD nor threads; esbuild's is Go's
  `js/wasm` port (no threads, no SIMD, goroutines switched by unwinding the stack). None can be
  rebuilt here without shipping other binaries than the app's.

## Decision

- **esbuild's transforms on the host's native esbuild** (`node-runtime/native-transform.ts`,
  `adapters/node/native-transform.ts`). A transform is a pure function of its input and options: no
  plugins, no file system. The esbuild shim (`WASM_BUILDS` in `adapters/node/install-rules.ts`) asks
  the runtime's hook first, which sends a transform to the host when
  - the app's esbuild is 0.25.0 or later and not newer than the host's (0.28.2): 1,254 transforms of
    every TypeScript and JSX module of the corpus and fixtures, with Vite's options and with others,
    gave the same code, source maps, warnings and errors from esbuild-wasm 0.25.12 and native 0.28.2;
  - every option is a transform option both have (`TRANSFORM_OPTIONS`) with a plain JSON value
    (undefined object properties allowed: Vite's tsconfigRaw has them), the log level prints nothing
    as esbuild works (`verbose`, `debug`), and the input is a string of at most 4 MB.
  The host transforms it with `logLevel: 'silent'` and answers the result; anything else (an error,
  warnings the app's log level would print, a refusal, the host busy) sends the shim to the app's own
  esbuild-wasm, which reports as its version does. The request goes over the runtime's file channel
  (ADR 0029) as a binary POST frame, else over HTTP. A warm Vite 6 run whose config bundle is kept
  (below) no longer starts esbuild-wasm at all.
- **Vite's config bundle from the project's last run** (`node-runtime/config-bundles.ts`, a source
  patch of Vite's `bundleConfigFile`, 5-8). A bundle is kept in the project's transform cache
  (ADR 0044: the run's dev-server cache, per project and install) with the text of every file it was
  made from and of the `package.json`, `tsconfig.json` and `jsconfig.json` files of their directories,
  and used only while each is unchanged (a missing file must still be missing). Bundles with findings
  for Vite 8's warning about native config loading, or with `import.meta.resolve` (Vite 8 registers a
  module hook as it bundles those), are not kept.
- `LAYOUT_VERSION` (the shim) and `TRANSFORM_VERSION` (the patch) are bumped.

## Consequences

- The branch against its starting point (`origin/quality-structure`), `scripts/bench.ts`, both sides
  as refs, interleaved, medians: (to come)
- Each change's own A/B:
  - host transforms (532b928, 664ca2c, a3280f1), against c4c760c, 3 rounds: warm
    `corpus/003-vite-react` 2.81 → 2.64 s (ready 0.87 → 0.64 s), `corpus/009-vite-react` 1.75 →
    1.69 s (ready 0.47 → 0.43 s), `corpus/012-vite-react` 1.90 → 1.98 s (start 0.54 → 0.51 s,
    ready 0.54 → 0.52 s); cold (first runs) 11.39 → 10.64 s, 13.38 → 13.20 s, 8.28 → 8.06 s. Over
    the channel a module's transform took 4-9 ms in the trace (39-45 ms while the runtime's thread was
    busy), over HTTP 15-64 ms (every request of a sandbox goes through Playwright), in WebAssembly
    18-110 ms one after another.
  - config bundles (e1f6d71), against a3280f1, 4 rounds, warm: `corpus/012-vite-react` 1.74 → 1.57 s
    (start 0.51 → 0.24 s), `corpus/003-vite-react` 2.45 → 2.16 s (start 0.77 → 0.43 s),
    `vite-react-counter` 1.67 → 1.56 s (start 0.71 → 0.59 s), `lit-vite` (no config file) 1.26 →
    1.30 s. (meta-frameworks: to come)
- CPU: a transform's work moves from the browser's WebAssembly to the host's native code, ~10x less.
- **Behaviour changes:**
  - An app's esbuild `transform` (esbuild 0.25.0-0.28.2, the listed options) is answered by
    Sandburg's esbuild 0.28.2. Its result is that version's (the same as 0.25's on every module
    tried); errors, and warnings the app asked to see, still come from the app's esbuild. A warm
    Vite 5-7 run may not load esbuild-wasm at all.
  - Vite's config file is not bundled again while it, what it imports from the project and the
    settings files beside them are as they were at the project's last run: the bundle (code and
    file list) is the one Vite made then.
  - Installs are made again once (from the package store), installed files transformed again.

## Security

- **The host route** (`POST /__sandburg/esbuild-transform`) is behind the host server's checks for
  every sandbox route (its sandbox by Host, `Sec-Fetch-Site` same-origin) and over the file channel,
  which accepts only the sandbox's own origin. It runs the host's own pinned esbuild, never the
  app's, on data: a transform reads no files, runs no plugins, and its options are an allowlist of
  transform options with plain JSON values (no build options such as `tsconfig` or `absWorkingDir`,
  no `plugins`); anything else is refused (422) before esbuild sees it. Nothing of the app is printed
  on the host (`logLevel: 'silent'`). Bounds: 4 MB per request, 4 transforms in progress per sandbox
  and 16 in all (503 beyond), 10 s per transform (503; its slot stays taken until esbuild is done).
- **Answers are cached by a digest** (SHA-256 of the host's esbuild version and the whole request),
  shared by all sandboxes: the host computes every entry itself, so no run can plant one.
- **The file channel's POST frames**: binary frames of at most 4 MB + 64 KB (larger ones close the
  channel), only to exactly `/__sandburg/esbuild-transform` (any other path is answered "ask over
  HTTP" without being served), a malformed header closes the channel; the route's own body bound
  applies. Text frames (GETs) keep their 64 KB bound.
- **Config bundles** live in the project's own transform cache, which the host gives only to runs of
  the same project and install (ADR 0044). An entry is code the project's own run produced from the
  project's own files; a run that tampers with it affects only the project's later runs, which run
  its code anyway. Entries for another file or working directory, or that do not parse, are not used.
- Tests: `test/unit/native-transform.test.ts` (versions, options, size, concurrency, timeout, cache,
  another sandbox's and another site's pages refused by the host server, the shim's fallback),
  `test/unit/host-socket.test.ts` (POST frames: other paths, oversized and malformed frames),
  `test/unit/config-bundles.test.ts` (changed inputs and settings, foreign and tampered entries,
  findings), `test/runtime/native-transform.test.ts` (the hook in the runtime: HTTP before the
  channel opens, the channel after, a thread through its parent's).

## What did not help

- **esbuild's Go service on a thread of its own** (esbuild-wasm's worker mode, the thread on the
  runtime's file system, started as esbuild loads): `angular-tasks` 5.23 → 5.13 s, start 3.55 →
  3.50 s (alternating fresh sessions, n=10 each). Go ran 904 ms on its thread against 736-790 ms on
  the runtime's (cold code, file calls through the thread's VFS), and the runtime's thread waited
  ~400 ms for it: the Angular CLI's pipeline waits for esbuild's results.
- **esbuild-wasm's messages without a timer** (its in-thread service posts each message with
  `setTimeout`): only 31 messages in an Angular run; no change.
- **Go's garbage collector off or rarer** (`GOGC=off`, `400`, `GOMEMLIMIT=1GiB`) for the lucide-react
  pre-bundle in Node: 3.1-4.7 s against 3.2-3.7 s, up to 1.5 GB resident. The time is Go's code.
- **The tiering budget for long pre-bundles**: cold `corpus/003-vite-react` runs (new config each, so
  no seed and no cache), n=3: V8's default 8.41 s (start +0.5 s), ADR 0027's 1.3e9 8.07 s, 1.3e8
  7.76 s; within the noise, as ADR 0038 found for warm runs.

## Not done

- **Native builds on the host** (Vite's pre-bundle, the Angular CLI's builds): esbuild's native
  resolver reads the host's file system (`package.json` and `tsconfig.json` files of parent
  directories, symlinks out of an install such as a `file:` dependency), which would bring host files
  into an app's bundle, and the builds' plugins are the app's JavaScript. The pre-bundle stays the
  largest WebAssembly cost of a first Vite 5-7 run (~5 s with lucide-react); a cross-project cache of
  it filled by Sandburg's own seed runs (ADR 0045's Vite seeds per stack) is the frameworks' lever.
- **SWC on the host**: there is no pinned native build with Next.js' transforms; `@next/swc-*` would
  be a native binary chosen by the app's Next.js version (and an install's `@next/swc-wasm-nodejs`
  can be any package, through an npm alias). SWC on worker threads with the runtime's compiled
  `WebAssembly.Module` (ADR 0037 compiled one per thread) would help only seedless runs.
- **esbuild's synchronous API** (`transformSync`, `buildSync`) could be offered with Go on a thread and
  `Atomics.wait`, as esbuild does in Node; the thread prototype above is most of it.
- **oxc's per-module transforms (Vite 8) from the transform cache**: they read tsconfig files in Rust,
  which a key would have to cover.
