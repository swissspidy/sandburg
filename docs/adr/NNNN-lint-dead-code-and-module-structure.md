# ADR NNNN: A linter, dead code, typed runtime messages and a split runtime

- Status: Accepted
- Date: 2026-10-24

## Context

The repository had no linter and no dead-code check; `tsc` was its only static check. Its largest
module, `src/node-runtime/worker.ts`, was 1,956 lines: the runtime's message loop, its state and
init, the buffer polyfill's patches, the runtime's built-in modules, how it gets files from the host
(downloads, synchronous requests, the file channel, digests) and the networking between runtimes.
`src` had 67 `as unknown as` casts and 911 `as` casts in all. The messages between a runtime and the
runtime that started it (a worker thread's or child process's parent) were untyped on both sides:
`FromWorker` typed what a runtime posts to the page, but a runtime also posts `net-*`,
`lb-request`, `wt-message` and `vfs-rpc` messages up, through an untyped `postMessage`, and the
parent read each message as `{ type: string; [k: string]: unknown }` with a cast per field. What the
page posts to a runtime (`ToWorker`) went through `Worker.postMessage`, which takes any value.

## Decision

### A linter: oxlint, type-aware, in `npm run lint` and CI

typescript-eslint does not support TypeScript 7 (its peer range ends at 6.1), so the linter is oxlint
with tsgolint (typescript-go) for the rules that need types. `.oxlintrc.json`:

- oxlint's correctness rules, plus rules for the bugs this code base can have: floating and misused
  promises, `await` of a non-promise, exhaustive switches over unions (a switch that leaves cases to
  others says so with `default`), numeric sorts without a compare function, `+` on `unknown`, unused
  variables and imports, `eqeqeq` (smart), `no-fallthrough`, `no-self-compare`, useless defaults,
  type assertions that change nothing.
- Off: rules that only churn here (`startsWith` over a regex, spreads, the thenables and unbound
  methods the runtime defines and captures on purpose, control characters in ANSI regexes,
  `String()` of `unknown`).
- **Boundary rules** (see Security): no `eval`, `Function` constructor or implied eval in the host's
  code; `node:child_process` only in the files that start processes now; `node:vm` nowhere; no
  `node:*` import in code that runs in the browser.

`npm run lint` lints the repository in 1.8 s (4.0 s of CPU) on a 4-core machine; with knip, 3.4 s.
CI runs it in the typecheck job.

### Dead code: knip

knip finds unused files, exports and dependencies. Its entries (`knip.json`) include what esbuild
builds from paths it cannot follow: the runtime's script and its injected shims, the host page, the
page's adapter, the compile worker, the service worker, the WebSocket shim and the page checks. The
runtime's polyfills are resolved by name (bundle.ts) and listed as used.

### Types at the message boundaries

- `messages.ts` has the whole protocol: `ToWorker` (to a runtime, from the page or its parent),
  `FromWorker` (to the page), `ToParent` (to the runtime that started it: `FromWorker`, `NetMessage`,
  `lb-request`, `wt-message`, `VfsCall`).
- A runtime posts up through `realPostMessage(msg: ToParent)`; the page through
  `NodeProcess.send(msg: ToWorker)`; `ThreadHost.childInit` returns the init message's type; the
  receivers (`startRuntime`, `ThreadHost.relay`, a thread's `onChild`, child_process' handler,
  `relayFromNested`) narrow by `type` instead of casting. A message of the wrong shape does not
  compile.
- What the program controls stays coerced where it is read: `postFatal` makes the stack it posts a
  string (a program can throw anything), and the exit code is `Number()`'d by its receivers (a
  program can call `process.exit('1')`).

### worker.ts, split by a script

Other branches edit worker.ts, so the split is mechanical and re-runnable:
`scripts/split-module.ts` moves top-level declarations by name (or registrations, by the text they
start with) from one module to another, unedited, and only adds and removes imports and exports. It
parses with oxc-parser (TypeScript 7 has no JavaScript API) and follows scopes (a local named like a
declaration that stays is not an import). `scripts/split-worker.ts` lists the moves; to redo the
split on top of other changes, check out the unsplit files and run it, then `npm run typecheck &&
npm run lint`.

| module | lines | what |
| --- | --- | --- |
| worker.ts | 1,956 → 819 | the message loop, the runtime's state, init, run, requests, WebSockets |
| messages.ts | 27 → 135 | ToWorker and SharedPreload beside FromWorker and ToParent (new) |
| buffer-patches.ts | 187 | the buffer polyfill's patches |
| async-context.ts | 158 → 176 | EventEmitterAsyncResource |
| host-files.ts | 412 | downloads on the side, synchronous requests, the file channel and digests, the page's compiler |
| builtins.ts | 286 | buildBuiltins |
| peers.ts | 226 | net connections and loopback requests between runtimes |

The modules that read worker.ts's state import it from worker.ts (live bindings); none assigns it
(TypeScript refuses an assignment to an import, so a move that would need one fails to typecheck).
The preload bundle stays in worker.ts, which init sets up. The runtime's script is still one esbuild
bundle with the modules hoisted into one scope.

### Numbers

| | main | this branch |
| --- | --- | --- |
| `as unknown as` in src | 67 | 60 |
| `as` casts in src | 911 | 858 |
| exports used only in their module | 44 | 0 (and 4 public types now exported by the package) |
| worker.ts | 1,956 lines | 819 lines |
| runtime script (bundleNodeRuntime) | 886,558 bytes | 887,725 bytes (+0.13%: the split's per-module comments, +650; the typed relays and coerced stack, +560) |
| static checks | `tsc` | `tsc`, `npm run lint` (3.4 s) |

## Bugs the linter found, fixed

Each fix has a test that fails without it.

- **`Readable.fromWeb`** (runtime): destroying the stream after its web stream errored rejected
  unhandled (`reader.cancel(err).finally(cb)`): the runtime wrote "Uncaught (in promise)" or emitted
  `unhandledRejection`, which servers often answer with `process.exit(1)`. Node emits only 'error'.
- **Parsing inside `.then(onRead, onError)`** (host): a throw in `onRead` is not passed to
  `onError`. A batch summary cut off (written with writeFile; a batch stopped while writing it)
  made every later batch in that directory fail before it started; a preload list that did not
  parse rejected in `recordLoad`, which the host calls with `void`: an unhandled rejection ends the
  host's process. Also an installed `package.json` that does not parse (prefetch, package versions).
- **The host's compile cache**: the same pattern in `CompileCache.load`, whose rejected promise then
  stayed cached for the project; `record()` (called with `void` for every compile served) rejected
  unhandled. A bundle whose header lengths do not add up to the file is now none.
- Smaller: the preload lists' flush was an async timer callback whose `mkdir` could reject
  unhandled; two numeric sorts in tests without a compare function (right only for single digits);
  44 type assertions that changed nothing (among them 4 `as unknown as` and 2 `as never`).

## Security

What this touches, and why the boundaries hold:

- **Lint rules that enforce boundaries** (ADR 0001, 0005): no `eval`/`new Function`/implied eval in
  host code (the host's one `Function` constructor, esm-names.ts, only parses and is never called; it
  carries a disable comment saying so); `node:child_process` only in install.ts, package-store.ts and
  resolver.ts (npm, with `--ignore-scripts`), reference/docker.ts, the Harbor wrapper (fence.mjs),
  scripts and tests, so a new place that starts a process is a reviewed change to the list;
  `node:vm` nowhere (it is not a security boundary); no `node:*` in browser code. Probe files (a
  child_process and a vm import in orchestrator/, vm in reference/, node:fs in node-runtime/) are
  refused with the rules' messages.
- **Caches read from disk** (the compile cache, preload lists, batch summaries) now treat a tampered
  or cut-off file as missing instead of failing, or crashing, the host; the compile cache checks a
  bundle's lengths against its file. Their keys are unchanged (digests and issued keys); the tests
  write cut-off and wrong-shape files.
- **The runtime's messages** are typed, not validated: they come from the runtime's own code (the
  app's code cannot post them: `realPostMessage` is captured before any program runs). The values
  a program controls (an exception's stack, an exit code) are coerced where they are posted or read.
- **The split** moves code between modules of the same bundle: no route, socket, origin check,
  limit or cache changes.

## Consequences

- `npm run lint` must pass in CI. A new floating promise, a non-exhaustive switch over a union, an
  unused export or an unlisted dependency fails it.
- The runtime's protocol is in one file, typed both ways.
- worker.ts is 819 lines; the parts that do not need init's state live in their own modules.
- Behaviour changes: the four readers above count a file that does not parse as missing (before,
  they failed the batch or the install phase, or ended the host's process); `Readable.fromWeb`
  no longer reports an unhandled rejection; the package exports four more types (`BatchRunSummary`,
  `ComparePair`, `SideOutcome`, `TimingStats`); `sha.js` and `process` are listed dependencies (they
  were installed as dependencies of crypto-browserify and readable-stream, at the same versions).

## What did not help, or was left

- **typescript-eslint**: does not support TypeScript 7.
- **`no-misused-promises` without exceptions**: six handlers (worker and server message handlers
  whose bodies catch everything) carry a disable comment instead of a rewrite.
- **Rules left off** because they flagged deliberate code: `unbound-method` (31: the runtime
  captures prototype methods before app code can replace them), `restrict-template-expressions`,
  `no-base-to-string` (string conversion of `unknown` is deliberate), `prefer-promise-reject-errors`,
  `no-deprecated` (`document.execCommand` is how the page checks type), `return-await`.
- **Moving more of worker.ts**: the preload bundle, init and the module system's setup assign the
  runtime's shared state; moving them needs setters, which is an edit, not a move.

## Not done

- The same split for `orchestrator/session.ts` (981 lines) and `adapters/node/index.ts` (720), which
  other branches edit this round: `scripts/split-module.ts` works on any module.
- Validating messages at run time where they cross from code the app controls (a program's
  `process.send` data, `wt-message` data) is not needed: they are structured clones passed through.
- Typing the remaining `as unknown as` casts: most patch prototypes and globals the DOM and Node
  typings do not describe (`Buffer.prototype`, `performance.memory`, `SharedArrayBuffer`'s growable
  options); a `lib` of es2024 and a few ambient declarations would remove some.
- A custom lint rule (oxlint's JavaScript plugins) for cache keys built from app-controlled names.
