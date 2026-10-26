# ADR 0056: The architecture as checked rules, one table per framework, contracts in one module each

- Status: Accepted
- Date: 2026-10-26

## Context

Rounds 3 and 4 (ADR 0047, 0053) split the largest modules, typed the runtime's messages and turned
three security invariants into lint rules. One level up, nothing described or checked the
architecture: which code runs where, which module may import which, and where a framework's
knowledge goes. A map of the import graph (oxc-parser, static, dynamic and `require` imports) on
this round's base (860c0eb) found:

- **Directories are not environments.** `adapters/node/` holds the adapter's host half and its
  browser half; `node-runtime/` the runtime, the host-side code that bundles it, and the page's npm
  installer (`node-runtime/npm/`, which runs in the host page, not in a runtime). The lint rule that
  refuses `node:*` imports in browser code is a file list (`.oxlintrc.json`): it missed **15 modules
  that run in a browser** (page-checks' locator.ts and expect.ts; the compile worker's esm-names,
  interop and tla; install-rules.ts, scripts.ts, sw-bridge.ts, transfer-trace.ts; node-runtime/npm's
  four) and listed one that runs only on the host (warmup.ts, which therefore also had the host's
  cache-key and one-server rules off).
- **One upward import**: the runtime's directory imported the node adapter (`node-runtime/npm/install.ts`
  → `adapters/node/install-rules.ts`).
- **Two import cycles**: the page checks' runtime.ts ↔ locator.ts ↔ expect.ts, and worker.ts with the
  modules split from it (builtins, host-files, peers), which import its state back.
- **Framework knowledge keyed by the detected framework in seven modules, three environments**:
  detection (framework.ts), the dev server's environment, spares at mount and dev command options
  (browser.ts, the page), build and cache directories as three hand-written regexes (threads.ts, the
  runtime), dev caches kept between runs (dev-cache.ts), telemetry switches (scripts.ts), the Docker
  reference's command lines (docker.ts). Adding a framework at react-router's level touched 4 files,
  at solid-start's 5.
- **Contracts defined twice**: the file channel's format and bounds on each end (the runtime's mailbox
  was `12 + (1 << 20)`, a copy of the host's MAX_BODY); the bundle framing (u32 header length, JSON
  header, bodies) hand-rolled at 6 writers and 5 readers in 8 modules; "is this dependency spec a
  registry version" twice, as the host's allowlist (spec-guard.ts) and the browser installer's prefix
  list, which spec-guard.ts said applied "the same rule".

## Decision

### The rules, checked (`scripts/architecture.ts`, `test/unit/architecture.test.ts`)

The script reads src/'s import graph from the syntax trees and checks:

- **Environments.** Each bundle's entry points are declared (host: index.ts, cli.ts; page: host.ts and
  the adapter's browserEntry; runtime: worker.ts and its injected shims; compile worker; service
  worker; app frame). A module runs wherever a value import reaches it from an entry. Code in a
  browser environment imports no `node:*` and no host-only package (esbuild, Playwright, oxc-parser),
  except what its bundle stubs (the compile worker's `node:crypto` and `esbuild`). Transitive, where
  the lint rule is a file list; type imports are erased and allowed.
- **Layers.** What a directory may import, type imports too: api › compare, reference › orchestrator ›
  the adapters' registry (adapters.ts) › adapters › page-checks, host, node-runtime › core (src/'s own
  files). The orchestrator reaches an adapter only through the registry, so a second adapter needs no
  orchestrator change; the runtime imports no host code.
- **Cycles.** Value imports form none but the known one (KNOWN_CYCLES), which the test requires to
  still exist, so the list only shrinks.
- **The lint config is kept true**: every module that runs in a browser is covered by
  `.oxlintrc.json`'s browser-only override, and the override lists no host-only file. The test caught
  each new shared module this branch added (file-channel.ts, framework.ts, spec-guard.ts,
  bundle-format.ts) before lint could miss it.
- `docs/architecture.md`'s tables (layers, environments) are generated (`--update`) and compared; the
  per-module map is printed by the script, not checked in, so a new file does not need a doc change.

Two tests feed the rules made-up graphs (a `node:*` import in runtime code, a host-only package in the
page, the orchestrator importing adapters/node directly, the runtime importing the orchestrator,
core importing a layer, a cycle; type and dynamic imports that make none). The test takes 0.2 s.

### What the map changed

- `node-runtime/npm/` → `adapters/node/browser-npm/` (git mv, importers' paths): the page's
  installer is the node adapter's browser half. The runtime imports no adapter code.
- page-checks: runtime.ts's helpers that locator.ts and expect.ts use (the app's frame, the run's
  settings, poll, named errors, guarded) moved to frame.ts, and `app` to app.ts, by
  scripts/split-module.ts (scripts/split-page-checks.ts redoes it): frame ‹ locator ‹ app ‹ expect ‹
  runtime, no cycle. The run's settings are a const object run() assigns into (an importer cannot
  reassign an exported `let`).
- The lint config's browser list: 15 modules added, warmup.ts removed (its host rules apply again;
  lint passes).

### One table per framework (`FRAMEWORKS`, src/framework.ts)

An entry per framework with everything keyed by it: `detect` (tried in the table's order: the
frameworks built on Vite before `vite`), `buildDirs`, `nodeModulesCaches`, `devCaches`, `quietEnv`,
`node` (spares at mount, env, dev command options) and `reference` (the Docker reference's script and
listen arguments). It is core (no imports): the host, the page, the runtime and the demo site's
generator import it. It is a `Record` over the `Framework` union, so a name in one and not the other
does not compile; test/unit/frameworks.test.ts checks result-schema.json's enum against it and pins
detection (16 cases). threads.ts derives its three patterns from it, dev-cache.ts its directories,
scripts.ts its DEV_ENV, browser.ts the env, spares and dev command options, docker.ts what it
supports and how it starts it.

| adding a framework at the level of | before | after |
| --- | --- | --- |
| react-router (detection, start) | 4 files: types.ts, result-schema.json, framework.ts, browser.ts | 3: framework.ts, types.ts, result-schema.json (the compiler and the test name the other two) |
| solid-start (and its build directory) | 5: the above and threads.ts | 3 |

What a framework needs of its packages stays filed by package (install-rules.ts' source patches and
WebAssembly builds, deferred-imports.ts): frameworks share packages. Page signals read for every app
(hydration markers in host/settle.ts, loading pages in app-ready.ts, error formats in classify.ts) stay
where they are read; docs/architecture.md says where each goes.

### Contracts in one module each

- **`src/file-channel.ts`**: the file channel's path, MAX_BODY, MAX_FRAME, MAX_POST, the answer's
  header and the runtime's mailbox size *derived from* MAX_BODY, with the format described once.
  host-socket.ts, host-server.ts, host-files.ts and the tests import them.
- **`src/bundle-format.ts`**: `bundleHead(header)` and `bundleHeader(bytes)` for every bundle of files.
  bundleHeader throws for bytes too short for the header they announce or a header that is not a list
  (which each reader already treated as a bad bundle), and copies the header out of shared memory,
  which Chromium's TextDecoder does not read (a first version did not: the runtime's prefetched-bundle
  test failed, Node's TextDecoder reads it and the unit test did not tell). The same bytes are written.
- **Dependency specs**: the browser installer's parseSpec asks spec-guard.ts' `isRegistrySpec`.

### Fixes the contracts turned up

- **A read report could close the file channel.** A runtime tells the host which preload-bundle files
  it read, 100 a report, each report one text frame. The host closes the channel on a text frame over
  MAX_FRAME (64 KB), and 100 long paths (~800 characters) make a larger one: the channel closed,
  nothing was reported, and every later file came over synchronous HTTP (5-7 ms a request instead of
  ~0.5 ms). Reports are now also bounded by their encoded size (MAX_FRAME less 1 KB); a key that alone
  would not fit is not reported (it is a hint for the next bundle). The host's bound is unchanged. A
  runtime test fails without it.
- **The browser installer's spec check** let through a directory (`.`, `..`), a local tarball
  (`x.tgz`), a protocol it did not list (`ssh://host/x`) and an alias to a file (`npm:x@file:../y`),
  which failed later with a less clear error; it now refuses what the host refuses.

### Numbers

| | base (860c0eb) | this branch |
| --- | --- | --- |
| modules that run in a browser, missed by the lint rule | 15 (and 1 host module listed) | 0, checked |
| upward imports (layers) | 1 | 0, checked |
| value-import cycles | 2 | 1 (worker.ts'), checked to shrink |
| modules with framework-keyed knowledge | 7 | 1 table, read by 6 |
| sites framing bundles by hand | 11 | 0 (one module) |
| definitions of the file channel's bounds | 2 (host, and a copy in the runtime) | 1 |
| unit tests | 304 | 316 |
| runtime tests | 78 | 79 |

On this branch (9ba31fa): typecheck, lint, `npm test` (316), `npm run test:runtime` (79) and the
page-checks (3), vite-frameworks (9), frameworks (7), angular (6), run (10), node (13) and fullstack
(7) e2e suites pass.

Warm runs, `node scripts/bench.ts --base 860c0eb --head 9ba31fa --fixtures
vite-react-counter,next-app-router,astro-app,nuxt-app --modes warm --rounds 3` (both sides in
worktrees, interleaved; medians, 3 rounds, 24 of 24 runs passed; a side's `.sandburg/` carried over
between rounds):

| fixture | base | this branch | |
| --- | --- | --- | --- |
| vite-react-counter | 1.45 s | 1.49 s | +3% |
| next-app-router | 4.76 s | 4.48 s | -6% |
| astro-app | 3.52 s | 3.53 s | +0% |
| nuxt-app | 4.77 s | 4.64 s | -3% |

Within the noise of 3 rounds: nothing here was meant to change a run's time (the code that runs is
the same; the read-report fix matters only for paths long enough to overflow a frame).

## Security

- **No boundary moved.** No route, socket, origin check, token, limit or cache key changed. The file
  channel's bounds have the same values, now in one module; the host's MAX_FRAME check is unchanged
  (the fix is on the runtime's side, which now stays under it).
- **The rules strengthen two invariants of ADR 0001/0047**: no Node module in browser code is now
  checked transitively from each bundle's entries, not by a hand-kept list (which had missed 15
  modules); host code that keeps caches (warmup.ts was exempted by mistake) is under the host's
  cache-key and one-server rules again.
- **Dependency specs**: the browser installer now applies the host's reviewed allowlist (spec-guard.ts,
  ADR 0040/0054) instead of a denylist; it refuses more, never less. The host install is unchanged.
- **Bundles read from caches**: bundleHeader bounds the header by the bytes there (a length past the
  end, a header that is not a list), and each reader keeps its own checks of the entries (dev-cache:
  each entry's shape and size against the body; compile cache: the lengths add up to the file). A
  test feeds it a cut-off bundle, a length of 2^32-1 and a non-list header.
- **The framework table** is data the host and the page read; it holds no secret and nothing an app
  controls (detection reads the app's package.json and paths, as before).

## Consequences

- `npm test` fails when browser code imports Node's modules or a host-only package (also through
  another module), when a layer imports a higher one, when the orchestrator imports an adapter's
  modules, on a new import cycle, when the lint config's browser list misses a browser module, and
  when docs/architecture.md's tables are stale.
- A new framework is an entry in FRAMEWORKS, its name in the union and in result-schema.json.
- docs/architecture.md is the map for a new contributor: one run's picture, environments, layers,
  the contracts and the module that defines each, where to add a framework, a route, a built-in, a
  cache, a browser module.
- Behaviour changes: a runtime whose read report would exceed a frame keeps its file channel (before:
  the channel closed and later files came over HTTP); `--install-in browser` refuses `.`, `..`,
  tarball paths, unlisted protocols and aliases to files up front. Nothing else an app or a user
  could notice.

## What did not help, or was left

- **dependency-cruiser or madge**: a 300-line script on oxc-parser (already a dependency) reads the
  graph, knows the bundles' entries and stubs, and runs in 0.2 s; a dependency would need the same
  configuration and could not check the lint config.
- **The per-module map in the doc**: checked in, it would fail every branch that adds a file; the
  script prints it instead.
- **knip --production** (exports used only by tests): all 43 it lists are exported for tests, none is
  dead.
- **A unit test of bundleHeader on shared memory**: Node's TextDecoder reads shared memory and
  Chromium's does not, so only the runtime test tells; the unit test keeps the case, with a comment.

## Not done

- **worker.ts' cycle**: its state (vfs, process, thread, caches) is module bindings the split modules
  import back, many reassigned in init. A state module of its own removes the cycle; worker.ts is
  edited by several branches a round, so it is listed in KNOWN_CYCLES instead.
- **Versioned caches by digest**: the install layout and the transforms are versioned by hand
  (LAYOUT_VERSION, TRANSFORM_VERSION in install.ts), bumped when install-rules.ts changes what an
  install writes; a digest of the rules would make a forgotten bump impossible, at the cost of a cold
  install after every edit of the rules (comments included).
- **Typing the service worker's and the WebSocket shim's messages** (sw.js, ws-shim.js are plain
  JavaScript, unchecked): `// @ts-check` with the DOM lib reports their ServiceWorker globals wrong; a
  worker tsconfig (ADR 0053's "not done") would do it.
- **`AdapterDescriptor<HostData>`**: the host install's data reaches the page's adapter as `unknown`
  and is cast there (`hostData as HostInstall`); a type parameter would type it end to end, a change to
  the public API (api/sandburg.api.md).
- install.ts (888 lines), threads.ts (754) and resolver.ts (744) are still the largest modules (ADR
  0053's scripts would split them); other branches edit them this round.
