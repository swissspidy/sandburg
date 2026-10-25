# ADR 0047: A linter, dead code, typed runtime messages and a split runtime

- Status: Accepted
- Date: 2026-10-24

## Context

The repository had no linter and no dead-code check; `tsc` was its only static check. Its largest
module, `src/node-runtime/worker.ts`, was 2,136 lines (after rounds 1-3; 1,956 when this work began): the runtime's message loop, its state and
init, the buffer polyfill's patches, the runtime's built-in modules, how it gets files from the host
(downloads, synchronous requests, the file channel, digests) and the networking between runtimes.
`src` had 68 `as unknown as` casts and 1,022 `as` casts in all. The messages between a runtime and the
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

`npm run lint` takes 1.9 s on a 4-core machine (oxlint 1.2 s, knip 1.2 s, run one after the other
by npm with some overlap of start-up).
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
| worker.ts | 2,136 → 848 | the message loop, the runtime's state, init, run, requests, WebSockets |
| messages.ts | 27 → 171 | every message type: ToWorker, SharedPreload, and ThreadInit, VfsOp and ProjectSnapshot from threads.ts, beside FromWorker and ToParent (new) |
| buffer-patches.ts | 209 | the buffer polyfill's patches |
| async-context.ts | 158 → 176 | EventEmitterAsyncResource |
| host-files.ts | 487 | downloads on the side, synchronous requests, files the host sends ahead, the file channel and digests, the page's compiler |
| builtins.ts | 339 | buildBuiltins |
| peers.ts | 226 | net connections and loopback requests between runtimes |

`scripts/split-page-checks.ts` does the same for `src/page-checks/runtime.ts`: 887 → 233 lines,
its locators to `locator.ts` (359) and its assertions to `expect.ts` (306).

The modules that read worker.ts's state import it from worker.ts (live bindings); none assigns it
(TypeScript refuses an assignment to an import, so a move that would need one fails to typecheck).
The preload bundle stays in worker.ts, which init sets up. The runtime's script is still one esbuild
bundle with the modules hoisted into one scope. Each split commit was checked line by line: every non-import line removed
is in the new modules, and only their header comments are new. With the split, the node, run,
websockets, fullstack, vite-frameworks, frameworks and page-checks e2e suites pass.

### Re-applied on the round-3 tree

This work began on 8daa57c and was brought onto main + #61 (e7f4a23) by a merge, with the splits
reverted first and run again on the merged tree (the move list gained main's files sent ahead,
and the thread types, which messages.ts would otherwise import from threads.ts: the package's
declaration build reaches messages.ts through the page's adapter, and threads.ts does not build
declarations). The rules stayed as they were; the code merged since was brought in line: 22 type
assertions that changed nothing, a `this` alias (resolver.ts's body cache, now bound methods), two
promise aggregators given a plain value (now `Promise.resolve(false)` and `Promise.resolve()`, which
is what they did), six exports used only in their module, socket data concatenated without
`String()` in tests. Two exceptions, each named in `.oxlintrc.json` or a comment:

- `src/node-runtime/bundle-cache.ts` (new on main) runs on the host (it keeps the runtime's builds in
  `.sandburg/bundles`), so it joins `bundle.ts` in the exemption from "no `node:*` in browser code".
  The rule is right; the file is in the runtime's directory but not in the runtime.
- A test client's async `connect` handler (host-bodies.test.ts) carries a `no-misused-promises`
  disable comment, as the earlier test servers do.

While the branch had `import type { ToWorker } from '…/worker.ts'` (between the typed messages and
the split), `npm run build` failed: worker.ts entered the package's declaration build. The split
moves the type to messages.ts, and the build passes.

### Numbers

| | base (main + #61, e7f4a23) | this branch |
| --- | --- | --- |
| `as unknown as` in src | 68 | 61 |
| `as` casts in src | 1,022 | 964 |
| exports used only in their module | 50 (44 found first, 6 in code merged since) | 0 (and 4 public types now exported by the package) |
| worker.ts | 2,136 lines | 848 lines |
| page-checks/runtime.ts | 887 lines | 233 lines |
| runtime script (bundleNodeRuntime) | 919,987 bytes | 921,157 bytes (+0.13%: esbuild's per-module comments, the typed relays and the coerced stack) |
| static checks | `tsc` | `tsc`, `npm run lint` (1.9 s) |

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
- worker.ts is 848 lines; the parts that do not need init's state live in their own modules.
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
