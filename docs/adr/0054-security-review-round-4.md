# ADR 0054: Security review (round 4): registry-only installs, parser fuzzing, the boundary map

- Status: Accepted; amended by [ADR 0061](0061-chromium-sandbox.md) (the boundary its map leaves out, between the app and the machine: Chromium's OS sandbox, now on by default, and site isolation); and by [ADR 0064](0064-monorepos-and-local-packages.md) (`file:`, `link:` and `workspace:` packages inside the project are linked by Sandburg, never given to npm; paths outside it stay refused)
- Date: 2026-10-25

## Context

Sandburg runs untrusted, generated apps (ADR 0001). Round 3's review (ADR 0040) found and fixed five
ways an app could cross a boundary into the host, other runs or the network, and left a few items
open. This round is an adversarial review, with fuzzing, of every boundary between an app and the
host: the host routes and sockets, everything the host parses from an app or from a package, and the
caches shared across runs. It closes one more boundary, fuzzes the host's app-driven parsers, and
writes the boundary map down so the next round starts from it.

### The attack surface, by component

What an app controls is its page and the runtime threads that share its origin. From there it reaches,
and the host must hold against, each of these:

- **The host server** (`src/orchestrator/host-server.ts`): one HTTP server for every sandbox, each a
  `*.sandburg.localhost` origin. Parses the request's `Host` (which sandbox), target and headers, and
  the body (bounded, ADR 0040). Refuses cross-site requests (`Sec-Fetch-Site`) and unknown sandboxes.
- **The file channel** (`src/orchestrator/host-socket.ts`): a WebSocket carrying the runtime's file
  requests. Parses raw WebSocket frames from the app. Accepts the upgrade only from the sandbox's own
  origin; bounds frame and body size.
- **The adapter's routes** (`src/adapters/node/index.ts` `serve`): compile, tla-scan, dev-cache
  read/write, compile-cache, preload and `nm` file reads. Each parses the path, query and body. Cache
  *writes* need the run's capability token from its own sandbox (ADR 0040); *reads* answer any sandbox
  that names a key (see "Accepted", below).
- **The egress gateway** (`src/orchestrator/egress.ts`): intercepts the context's HTTPS (CDP Fetch),
  answers allowlisted origins from a shared disk cache or upstream, blocks the rest. Parses request
  URLs, methods and headers, and upstream responses and redirects.
- **The egress proxy** (`src/orchestrator/egress-proxy.ts`): the context's proxy for what the gateway
  cannot see. Parses CONNECT targets; refuses plain HTTP and, for intercepted contexts, every tunnel.
- **Installation** (`src/adapters/node/install.ts`, `resolver.ts`, `package-store.ts`): the host runs
  npm over the app's `package.json`, `overrides` and lockfile, and unpacks package tarballs. This is
  the widest parser surface the host exposes to app-controlled input.
- **Caches shared across runs**: the package store (by integrity), transforms and host compiles (by
  content digest), the dev-server caches and framework seeds (by issued key), the egress cache (by
  URL), and the preload and package lists.

## Decision

- **The host installs registry dependencies only** (`src/adapters/node/spec-guard.ts`, wired into
  `install.ts`; landed with #67, with its review fixes). A dependency that is not a registry package — a git or directory dependency, a URL or
  a `file:`/`link:`/`workspace:` spec — is fetched by npm through pacote, which *prepares* git and
  directory dependencies (installs their dependencies and runs their `prepare` script) regardless of
  `--ignore-scripts`: that flag governs the project's own lifecycle scripts, not the preparation of
  git and directory dependencies. So each dependency spec is checked before npm runs — in
  `dependencies`, `devDependencies`, `overrides` and the project's lockfile — and only a registry
  version, range, dist-tag or `npm:` alias of one is installed; anything with a protocol or a path
  fails the install as unsupported, as the browser installer already refuses (ADR 0018). The check is
  an allowlist of shapes, not a denylist of prefixes: a registry range is built from semver's own
  characters, so a spec with a `:` or a `/` outside an alias name, or a bare `.`/`..`, is not one
  whatever it looks like. The same check requires a lockfile's `resolved` tarball URLs to be on npm's
  configured registry origin (the public registry by default) — any other host would be fetched by
  `npm cache add` or by npm during the install — and rejects a `link` entry or a package whose declared
  dependency ranges include a non-registry spec. It runs on the project's own lockfile and again, after
  resolution, on the tree npm resolved, so a git, directory or off-registry dependency a registry
  package pulls in transitively is refused before any package is unpacked or the full npm install
  fetches it. The resolver worker rejects a non-registry dependency before pacote fetches its manifest
  (which for a git or remote dependency is the clone or the tarball itself), so resolution never
  reaches that host; and npm's `git` binary is pointed at a path that does not exist, so a transitive
  git dependency cannot be cloned even on the CLI fallback path.

- **A sandbox's file channels are bounded** (`host-server.ts`). A sandbox's pages open a file channel
  per runtime helper; a per-sandbox cap (256, well above what any run opens) keeps one sandbox from
  opening enough to exhaust the host's file descriptors and starve other runs in the same process.
  Further upgrades get a 503, and a slot is released when a connection ends (a hijacked upgrade socket
  signals the client's disconnect with `end`, so the release listens for `end` as well as `close`).

- **The host's app-driven parsers are fuzzed** (`test/unit/parser-fuzz.test.ts`). The file channel's
  WebSocket frame reader runs in the `upgrade` handler's `data` listener, outside any try/catch, so a
  throw there would be an uncaught exception that ends the host process (the ADR 0040 F1 class); the
  CONNECT parser runs for every tunnel a page opens. Both are now fuzzed with mutated input across
  chunk boundaries, asserting that neither throws and that the CONNECT parser's output stays within its
  invariants. A fast fixed-seed version runs in CI; longer runs (below) were done while writing them.

## The boundaries and their tests

| Boundary | Enforced in | Tested by |
|---|---|---|
| The host installs registry packages only (no git/dir/URL/file prepare on the host) | `spec-guard.ts`, `install.ts`, `resolver.ts` | `unit/spec-guard` (the allowlist, manifest, overrides, v1/v3 lockfiles, registry-host resolved URLs), `unit/install-specs` (the Installer refuses git/file/URL deps and a non-registry lockfile, writing nothing), `unit/install-transitive` (a registry package's off-registry-tarball dep refused during resolution with no request to that host; its file: dep refused by the resolved-tree check; resolved URLs off the registry host refused) |
| The file channel frame reader never crashes the host | `host-socket.ts` `readFrames` | `unit/parser-fuzz` (mutation fuzzing across chunk boundaries), `unit/host-socket` |
| One sandbox cannot exhaust the host's file descriptors through the file channel | `host-server.ts` (per-sandbox cap) | `unit/host-server` (a sandbox refused past its bound, a slot freed on close, another sandbox unaffected) |
| CONNECT targets parse to a bracketless host and a valid port, or nothing | `egress-proxy.ts` `parseConnectTarget` | `unit/parser-fuzz` (mutation fuzzing of the target), `unit/egress-proxy` |

The round-3 boundary table (ADR 0043) stands; this adds the installer's spec allowlist to it and
extends the parser coverage.

## Fuzzers

Each has a fast fixed-seed unit test and was run longer by hand while writing it; none found a crash.

- **File-channel frame reader.** Mutated byte streams (random bytes, biased toward plausible frame
  headers) in one to four chunks. Fixed seed: 40,000 iterations in CI (~0.4 s). By hand: 1.5M
  iterations.
- **CONNECT target parser.** Mutated targets from a bracket/colon/port/host alphabet. Fixed seed:
  200,000 iterations in CI (~0.2 s). Checks no throw and the host/port invariants.
- **Registry-spec allowlist.** Mutated dependency specs cross-checked against npm's own
  `npm-package-arg` (`unit/spec-guard`): every spec the allowlist accepts, npa must classify as a
  registry version/range/tag or an alias to one. Fixed seed: 50,000 iterations in CI (skipped where
  npm is not on PATH). It found that a `.tgz`/`.tar`/`.tar.gz` suffix or a leading `.` makes npm treat
  a spec as a local tarball or directory even without a slash or protocol; the allowlist now rejects
  those shapes.

## Open items from ADR 0040, decided

- **Reads by key** (`/__sandburg/dev-cache/<key>/bundle`, `/compile-cache/<key>`): **accepted.** A key
  is a digest of a project's own files and install, or a seed's public inputs; a page that can name a
  key either has the project already or is naming Sandburg's own seed content. Binding reads to the run
  would cost a lookup per bundle for nothing a page does not already have.
- **Preload-list pollution**: **accepted.** A page that fetches another install's files (by naming its
  key) can enlarge that install's preload bundle, and the per-package list can make an install preload
  more of *its own* files. Integrity holds in both cases (the files are always the install's own); the
  only cost is a larger bundle.
- **Compile CPU**: **accepted** (as ADR 0040; see "Decisions on resource fairness" for the reasoning).
- **esbuild error text** (the compile route's 400 body): **accepted.** The message is esbuild's, about
  the app's own code and the app-provided `path`; it names no host path.

## Supply chain

npm runs with `--ignore-scripts`, so the project's lifecycle scripts do not run on the host. The
registry-only rule above closes the remaining way package *contents* could run code on the host (git
and directory dependency preparation), transitively as well as at the top level, and keeps every fetch
on the configured registry host. The in-browser installer (`src/node-runtime/npm`) was reviewed and
already holds: it refuses non-registry specs (transitive ones included) and ignores a lockfile's
`resolved` URL unless it is on `registry.npmjs.org`, re-resolving from the packument otherwise. Tarball
unpacking keeps entries inside the package (ADR 0040
F5) and verifies integrity before a package enters the store; bin links are normalized to stay inside
the package (ADR 0032, 0043). Case-insensitive name clashes and `exports`/symlink handling were
reviewed and are npm's own, over integrity-checked registry tarballs.

## Other surfaces reviewed

No change was needed in these; they are recorded so the next round need not re-derive them.

- **The service-worker shim (`sw.js`) and the WebSocket shim (`ws-shim.js`)** run on the sandbox
  origin, same-origin as the app, and add no host-facing parser: app requests they forward reach the
  host only through the host server, which applies its own checks. App responses are marked
  `cross-origin-resource-policy: same-origin`.
- **The dev-cache and seed routes under concurrent runs.** A write needs the run's own token, bound to
  its key and sandbox and spent once (ADR 0040). Two runs of the same versions racing for a seed each
  hold a token for their own sandbox only; the seed run writes the shared cache, and a same-key app
  gets a read, not a write. A run racing itself only overwrites its own cache.
- **Tarball contents.** The tar reader keeps only regular files, so a symlink, hardlink or device
  entry in a package tarball is dropped (no symlink escape); entries that would land outside the
  package are dropped (ADR 0040 F5). Bin links are normalized so a name or target cannot point outside
  the package (ADR 0032, 0043). Case-insensitive name clashes are not a concern on the Linux host, and
  the store is content-addressed by integrity. A package's `exports` cannot widen what the host serves:
  the file routes require a `node_modules/` prefix and reject `..`.

## Decisions on resource fairness

- **Per-sandbox compile fairness: accepted.** The host's `/__sandburg/compile` runs esbuild
  synchronously on the main thread, so in a batch one sandbox's large or frequent compiles can delay
  siblings in the same process. It is bounded in memory by input size (ADR 0039) and in input size
  (`SOURCE_BODY_MAX`, 32 MB), and it is proportional, not asymmetric: the compile route's regex passes
  were checked and none backtracks catastrophically (each nested quantifier's branches are mutually
  exclusive by first character). The only true fix is compiling off the main thread, which ADR 0030
  measured as no gain; revisiting it is a performance task, not a boundary fix, so it is left as future
  work rather than changed here.

## Consequences

- A project that declares a git, directory, URL or `file:`/`link:`/`workspace:` dependency, in its
  `package.json`/`overrides` or its lockfile, or pulls one in transitively through a registry package,
  now fails the install as `runtime-unsupported` (as the browser installer already reported it)
  instead of the host cloning, fetching or reading it. A lockfile `resolved` on a host other than the
  configured registry is refused. No fixture or corpus project uses such a spec (verified: e2e node,
  run and browser-install all pass).
- `INSTALL_FLAGS` gains `--git=<nonexistent>`; npm accepts it and a normal registry install is
  unchanged.
- No run's speed changes: the spec check is a handful of regex tests over the manifest and lockfile
  before npm runs, the file-channel bound a counter per sandbox, and the fuzzers are tests only.
  Measured on the round-4 tree (`scripts/bench.ts`, warm, 3 rounds, medians): next-app-router
  6.23 s → 6.17 s (−1%); vite-react-counter 1.71 s → 1.83 s, a median pulled by one noisy round (head
  rounds 1.8/1.8/2.3 s against base 1.7 s throughout) rather than any work the change adds to a run.

## Reporting

A boundary that could be crossed against the current code was reported to the maintainers first and
fixed with a neutral commit message; this ADR describes the defences and tests, not the crossings.
