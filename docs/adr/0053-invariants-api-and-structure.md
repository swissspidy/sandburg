# ADR 0053: Security invariants as lint rules, an API report, and the host's largest modules split

- Status: Accepted
- Date: 2026-10-25

## Context

Round 3 (ADR 0047) added oxlint and knip, typed the runtime's messages and split worker.ts with a
re-runnable script. What it left: `orchestrator/session.ts` (1,098 lines on this round's base) and
`adapters/node/index.ts` (923) were the host's two largest modules, edited by several branches a
round; the security model's invariants about caches, the host's one server and the package store's
hard links were review knowledge, not checks; nothing noticed an accidental change to the package's
public API, and most of it had no doc comment; 61 `as unknown as` casts remained, many for globals
the DOM and Node typings do not describe; and the runtime's polyfills had not been looked at for
size since they were added.

## Decision

### Three security invariants as lint rules (`lint/sandburg-plugin.ts`)

An oxlint JavaScript plugin, loaded by `.oxlintrc.json` and run by `npm run lint`, with tests on
oxlint's RuleTester (`test/unit/lint-rules.test.ts`, 28 cases). Each rule encodes an invariant of
ADR 0001/0005:

- **`sandburg/cache-key-digest`** (host code): *a cache on the host is keyed by digests, not by
  names an app controls.* A path passed to an fs write (writeFile, rename's target, mkdir, copy,
  link, open, …) that lies under a cache directory (a part named for `.sandburg`, a cache, a store,
  bundles, installs or seeds), or the key of a long-lived map named as a cache (module scope or a
  class field), and that is built from a name an app controls (`name`, `rel`, `location`,
  `specifier`, `pkg`, `request`, `url`, `pathname`, `path`, …) must also include a digest (a
  `createHash(…).digest()`, or a part named digest/hash/sha/integrity). The rule follows a path
  through the `const`s it was built from and through `path.join`/`resolve` and string methods; a
  path that arrives as a parameter is checked where it is built. Names are the contract.
- **`sandburg/one-host-server`** (host code): *the host listens with one server, whose handlers
  check every request's sandbox and site and the file channel's origin.* `createServer`,
  `createSecureServer` and `Server` from node:http, https, http2, net and tls (named or through a
  namespace) are refused outside host-server.ts and the reviewed exceptions, which turn the rule off
  by file in `.oxlintrc.json`: the egress proxy and the reference runtime's port probe. A route is
  added to an adapter's `serve()`, behind the host server's checks.
- **`sandburg/no-write-in-place`** (install.ts, install-rules.ts, package-store.ts): *the package
  store's hard-linked files are never written in place.* writeFile, appendFile, truncate, chmod, a
  writable open or a write stream on a path must remove the path first in the same block (as
  `replaceFile` does), write under a temporary name (then rename), or pass an exclusive flag
  (`wx`). A removal in another block or function does not count.

On this tree the rules found no bug. Four reviewed exceptions carry a disable comment with the
reason (a tarball's files written into a new directory beside the entry its integrity names, twice;
the install type cache, keyed by an install directory a digest names; a chmod of a directory an
install made), and npm's `node_modules/.package-lock.json` is written with flag `wx` (its
node_modules is new: the write cannot meet an existing file, and now could not change one if it
did). `npm run lint`: 2.3 → 2.9 s (loading the plugin).

### Types

- `lib` is es2024 (target stays es2022; Node ≥ 22.18 and the Chromium we drive have all of it):
  growable SharedArrayBuffer and `String#toWellFormed` are typed.
- `src/globals.d.ts` declares, with a doc comment each and optional where they may be missing, the
  globals this project defines or reads: the host page's `__sandburgQuiet`, `__sandburgReadFiles`,
  `__sandburgWriteFile` and `__sandburgWs`, axe in an app's frame, `performance.memory`, the static
  demos' `__sandburgBase` and `__sandburgServiceWorker`. sqlite/core.ts declares sqlite3.js's two.
- loader.ts's `Module` type has `mainModule`; worker.ts uses Module's type instead of three casts.

`scripts/code-stats.ts` counts from the syntax tree (oxc-parser) instead of a grep, which also
counted import renames, comments and strings (ADR 0047's 964 `as` is the grep's count of the
same tree whose syntax tree has 602).

### An API report (`api/sandburg.api.md`)

`scripts/api-report.ts` emits the package's declarations (`tsc -p tsconfig.build.json`, 0.5 s) and
walks them from `dist/index.d.ts`: each export to the module that declares it, each declaration to
the types it names. The report (comments and private members left out) is checked in;
`test/unit/api-report.test.ts` fails when the API differs from it (an optional field added to
RunOptions fails it) or when an exported declaration has no doc comment. A change on purpose is
`node scripts/api-report.ts --update` and a reviewed diff.

The first report found six types a consumer's code reaches but could not name: `RunRenderer`,
`ClassifyInput`, `Rates` (exported as `CompareRates`), `DockerReferenceOptions`, `SnapshotManifest`,
`SnapshotRecord`, now exported (type-only); and 48 of the 56 exported declarations without a doc
comment (Session, runBatch, RunOptions, RunResult, …), which now have one, as do Session's open,
close and run and SnapshotStore's put and get.

### Errors a run reports

They already had one shape: a phase that fails or times out records a `SerializedError`
(`{ name, message, code?, stack? }`) in its `PhaseRecord`, and `classify()` makes the run's
`Failure` of the phases, checks and page errors. `test/unit/run-errors.test.ts` now pins it
(an install error's code and stack, a thrown string, a non-string code, a timeout named
PhaseTimeout and never infra, an AdapterError from the host page over RPC, the browser's failures
as infra, skipped phases in order). No `catch {}` in src is without a statement or a comment
(code-stats); the `.catch(() => {})` calls read in the host are best-effort work (caches, prefetch,
cleanup, a promise awaited elsewhere) and stay.

### What a result keeps of an app's strings (`src/orchestrator/limits.ts`)

An error's message and stack (a phase's, an uncaught one in the page), a console line and a check's
message are the app's: one could be 50 MB, and result.json, the batch summary and comparison report
built from it, and the host's memory (up to 100 page errors and 500 console lines a run) took them
whole. A run keeps the first 16,384 characters of each (2,000 of a console line and its URL, as
before for the line; 200 of an error's name and code), as a string of its own (a slice would keep
the whole string alive), and says how many more there were: `… (N more characters)`. They are
capped where they are recorded (RunState's error serializer, the page's pageerror and console
handlers) and once more over the whole result before it is written (the checks' messages and the
Failure's message and evidence). test/unit/result-limits.test.ts: an app that throws, logs, fails a
phase and a check with 50 MB strings leaves a result.json under 512 KB.

### Polyfills: each package once, and the url polyfill as Node's

- **Duplicate packages** (`src/node-runtime/bundle-dedupe.ts`): npm nests a copy of a package
  wherever the one above does not satisfy the range, and esbuild bundled each. A file of a nested
  copy now resolves to the same file of the copy whose directory sorts first, when they are the same
  package: same version, the file's bytes the same, and every dependency the two would require
  resolving (Node's walk up node_modules) to one directory or to the same package in turn, through
  the whole resolved closure (cycles included). node:crypto's script
  (`node-crypto.js`): **1,242,331 → 691,598 bytes (-44%)**: five copies of bn.js 4.12.5, one of
  readable-stream 2.3.8, string_decoder 1.1.1, isarray, two of safe-buffer. The runtime's, zlib's
  and wasi's scripts are byte for byte as before. A runtime test checks what those packages do
  (ripemd160, ECDH, Diffie-Hellman, RSA sign, verify and publicEncrypt) against Node.
- **The url polyfill's queries** (`src/node-runtime/url-querystring.cjs`): url@0.11.4 parsed
  `url.parse(s, true).query` and formatted `url.format({ query })` with qs, where Node uses
  node:querystring: qs nests `a[b]=1` into objects and turns a key repeated more than 20 times into
  an object. The polyfill's `qs` now resolves to querystring-es3 (already in the script), as
  url@0.11.0 had it. The runtime's script, which every runtime, thread and spare compiles:
  **921,157 → 851,822 bytes (-7.5%)**. A runtime test compares with Node; it fails without this.

### session.ts and the node adapter, split by scripts

`scripts/split-session.ts` and `scripts/split-node-adapter.ts` move declarations by name with
`scripts/split-module.ts`, as ADR 0047's split-worker.ts does. split-module.ts now also keeps a
moved name exported when a file takes it with `import()` (tests that set SANDBURG_INSTALL_DIR
first), and prints those files; split-node-adapter.ts updates the four such tests.

| module | lines | what |
| --- | --- | --- |
| orchestrator/session.ts | 1,113 → 700 | the public options and types, Session, runProject, the checks phase |
| orchestrator/run-state.ts | 235 | RunState, PhaseTimeout, RpcError and unwrap, serializing errors, infra |
| orchestrator/app-ready.ts | 145 | the ready phase's waits and early failures |
| orchestrator/launch.ts | 57 | Chromium's launch options |
| adapters/node/index.ts | 923 → 262 | the adapter: serve(), the `node` descriptor, its host install |
| adapters/node/installs.ts | 10 | the shared installer and the caches' directory |
| adapters/node/dev-cache.ts | 189 | dev servers' caches, and the write capabilities (tokens) |
| adapters/node/preload.ts | 277 | preload lists and bundles |
| adapters/node/read-ahead.ts | 131 | files read ahead and pushed ahead |
| adapters/node/seeds.ts | 124 | Next.js' and Vite's seed runs |

(session.ts was 1,098 lines on the base; this branch's doc comments made it 1,113 before the split.)
The installer moves first, so that the adapter's modules form a chain without cycles (installs ←
dev-cache ← preload ← read-ahead; seeds) and none imports index.ts; the session's modules import
only a type from session.ts. Each split was checked line by line: every non-import line removed is
in the new modules, whose only new lines are header comments and `export` keywords. The public
types stay in session.ts, so the API report is unchanged by the split.

To redo the splits on a newer tree: revert the split commits (the two "Split …" commits), merge,
then

    node scripts/split-session.ts && node scripts/split-node-adapter.ts
    npm run typecheck && npm run lint && npm test

### Numbers

| | base (origin/quality-structure, c4c760c) | this branch |
| --- | --- | --- |
| `as` expressions in src (syntax tree) | 602 | 565 |
| `as unknown as` in src | 61 | 43 |
| empty `catch {}` without a comment | 0 | 0 |
| package exports (names) | 56 | 62 (all 6 new are types) |
| exported declarations without a doc comment | 48 | 0 |
| longest module | session.ts, 1,098 lines | worker.ts, 847 (session.ts 700, adapters/node/index.ts 262) |
| runtime script (node-worker.js) | 921,157 bytes | 851,822 bytes |
| node:crypto's script (node-crypto.js) | 1,242,331 bytes | 691,598 bytes |
| lint rules of the project's own | 0 | 3 (28 test cases) |
| `npm run lint` | 2.3 s | 2.9 s |
| unit tests | 196 | 237 |
| runtime tests | 69 | 71 |

On this branch (1f6cc37), from an empty `.sandburg`: the run (10), node (13), vite-frameworks (9),
frameworks (7), angular (6), fullstack (7), batch (4), page-checks (3), browser-install (6) and
websockets (3) e2e suites pass, as do `npm test` (233), `npm run test:runtime` (71), typecheck, lint
and build.

Warm runs, `node scripts/bench.ts --base origin/quality-structure --head 1f6cc37 --fixtures
vite-react-counter,next-app-router,astro-app --modes warm --rounds 3` (both sides in worktrees,
interleaved; medians, 3 rounds, 18 of 18 runs passed; a side's `.sandburg/` carried over between
rounds; a 4-core machine):

| fixture | base | this branch | |
| --- | --- | --- | --- |
| vite-react-counter | 1.56 s | 1.58 s | +2% |
| next-app-router | 5.32 s | 5.19 s | -2% |
| astro-app | 4.07 s | 3.94 s | -3% |

Within the noise: nothing here was meant to change a run's time. The smaller runtime script is
compiled by every runtime, but its 69 KB is ~4% of what a warm run compiles and its effect is under
what three rounds resolve; node:crypto's script loads only when a program uses what
node:crypto takes from crypto-browserify (not the common hashes, builtins/hash.ts), so its effect
is on those programs' first use, not on these fixtures' totals.

## Security

- The three rules encode invariants of the security model (above); they found no violation on this
  tree. Their limits: they see one file at a time and trust names (a digest's name says digest; a
  name an app controls is one of a list), so a key laundered through a parameter or an unusual
  name passes. They make the common mistakes fail CI, not review unnecessary.
- The ADR 0047 boundary rules stay as they were.
- `node_modules/.package-lock.json` is written with an exclusive flag; nothing else in the install
  path changed.
- The deduplication runs on the host at build time over Sandburg's own dependencies, never over an
  app's; it shares a file only when its bytes, its package's version and its dependencies'
  resolved versions are the same, so the code that runs is the same.
- The splits move code between modules: no route, socket, origin check, token, limit or cache key
  changed (the write capabilities move together into dev-cache.ts).

## Consequences

- `npm run lint` fails a cache key built from an app's names without a digest, a new server in the
  host, or an in-place write in the install code; `npm test` fails an API change that is not in
  api/sandburg.api.md, and an export without a doc comment.
- The host's largest module is 700 lines; the node adapter's capability tokens are in one module.
- Behaviour changes: an error message, stack or check message over 16,384 characters (a console
  line over 2,000) ends in `… (N more characters)` in results. `url.parse(…, true).query` and `url.format({ query })` in the runtime now give
  Node's results (before: qs's nesting and array limit). The package exports six more types.
  Nothing else an app or a user could notice.

## What did not help, or was left

- **Typing `self` in the runtime's files** (worker.ts's `self as unknown as Worker`, the compile
  worker's): the project has one `lib` with the DOM, whose `self` is a Window; a separate tsconfig
  for worker code is a larger change than the two casts it removes.
- **A cache-key rule on types** (a branded `Digest`): oxlint's JavaScript plugins have no type
  information, and tsc alone cannot tell a cache path from another; the rule works on names.
- **Uint8Array#toBase64**: typed only in lib esnext, which would also admit APIs Node 22 lacks;
  its cast stays.
- **Making url's dependency qs a dependency of ours** to pin it: not needed, the alias removes it.

## Not done

- install.ts (802 lines), threads.ts (754) and resolver.ts (694): the same scripts would split them;
  other branches edit them this round.
- The remaining polyfill weight in the runtime's script: `assert` (72 KB) and `util`'s
  is-typed-array chain (get-intrinsic, call-bind and the like) are evaluated by every runtime;
  either could become a runtime library (RUNTIME_LIBS) loaded on first use.
- axe-core is MPL-2.0 (file-level copyleft; we ship it unmodified) and querystring-es3 declares its
  MIT licence only in its License.md; the other 150 runtime dependencies are MIT, ISC, BSD,
  Apache-2.0 or 0BSD.
