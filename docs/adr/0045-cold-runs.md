# ADR 0045: Cold runs: trimmed packuments, read-ahead and pushed modules, a lighter host transform path

- Status: Accepted
- Date: 2026-10-25

## Context

After ADRs 0026, 0032 and 0035, a cold run (empty `.sandburg/`, warm `~/.npm`) of
`vite-react-counter` took ~6.4 s on an idle 4-core machine, `astro-app` ~19.5 s, `sveltekit-app`
~13.8 s, `next-app-router` ~20-24 s. `scripts/profile.ts --cold` (new: it profiles a session's
first run), CPU profiles of the host and of npm's resolver (`node --cpu-prof`), a log of every
request the host answered, and a replay of a cold start's file requests through `serve()` showed:

- **Resolution was reading packuments.** The resolver's worker spent ~1.8 s of its 2.6 s busy time
  in a `vite-react-counter` install reading full packuments (`JSON.parse` 0.54 s, decoding 0.27 s,
  cacache's hash 0.28 s, GC 0.36 s). They are mostly fields no install reads: Vite's 39 MB is 35 MB
  of a `licenseText` in each version; npm's cache here held 523 packuments, 498 MB, half of it
  readmes, maintainers, `exports`, dev dependencies, legacy PGP signatures and the like. ADR 0035's
  "derived cache of manifests" would have to reproduce make-fetch-happen's freshness rules.
- **An npm process per binding.** Each napi-rs package's candidate WASI binding was checked with
  `npm view` (2-4 per install, ~0.3-0.6 s of CPU each), and WebAssembly builds were copied into
  place with `fs.cp` (0.14-0.27 s, the last step of an install).
- **A cold pre-bundle read thousands of raw files one request at a time.** In
  `corpus/012-vite-react` (Vite 6, lucide-react), Vite's first pre-bundle (esbuild) read
  lucide-react's 1,550 icons and their source maps: 3,101 synchronous requests at ~2.3 ms, 7.3 s of
  a 9.4 s ready phase. A second app of the same stack ran with them in its preload bundle (ready
  0.7 s). Host time per request was below 1.5 ms: the cost was the round trip, one file after
  another.
- **A cold start waited on a busy host.** In a cold `astro-app` start the host's main thread was
  77-91% busy for seconds, and the runtime made ~1,470 single requests (~600 for transforms) while
  the predicted preload bundle was built (3.6 s). The transform path was mostly overhead around
  esbuild: promise-based reads of the source and of the cached transform (open, stat, read, close
  through libuv's pool), a `mkdir` and a write awaited before answering, a package "type" lookup
  that tried every directory up to `node_modules` for a `package.json` (~0.57 s of a cold Next.js
  start), and the wrapper-clash check (ADR 0030), whose regex sent 330 of 2,278 Astro modules to
  V8's parser for none that clashed. esbuild's synchronous API also started its worker and process
  on the first compile (~50-120 ms).
- **Stack-level reuse.** A never-seen app with an installed app's dependency set reuses the install,
  transforms (by content), preload lists (by package version) and compiles (by digest); with a
  similar set, npm resolves only the difference (0.8 s). What it does not reuse is the project's own
  caches: a Vite app's pre-bundle (seeded only from the third app of a stack, ADR 0016) and its
  compile cache. In the corpus most Vite seed keys come in pairs (64 Vite apps: 21 keys, 11 of them
  with 2 apps, 2 with 3).

## Decision

- **Trimmed packuments in npm's cache** (`TrimmedPackuments` in `src/adapters/node/resolver.ts`).
  In the resolver's worker, minipass-fetch's `Body.json` is wrapped: when pacote parses a packument
  of 64 KB or more that make-fetch-happen serves from npm's cache (fresh, or revalidated with a 304:
  the same bytes, named by `x-local-cache-hash`), a helper thread at the lowest CPU priority (Linux:
  `setpriority` on its thread id) parses the same bytes, drops the fields `trimPackument` lists, and
  stores the rest in npm's cache (`sandburg:packument-trim:1:<the entry's key>`, cacache) with the
  integrity of the bytes it came from. A later read of that entry with the same integrity is
  answered with the trimmed packument, and the cached body is left unread. npm still decides
  freshness and revalidation; only the body it answers with is replaced by what it trims to. A
  newer packument, a response from the registry, or a trimmed entry cacache refuses is read in full.
  At most 64 MB of copies wait for the helper; more are trimmed another time.
- **`npm view` in the worker** (`Resolver.view`): pacote picks a matching version from the
  packument with npm's options; none is null, as `npm view` printing nothing was. Without a worker
  (another npm layout), `npm view` runs as before.
- **Builds and bindings hard-linked** into installs (`place` in `install.ts`, the store's
  `linkTree`), copied where a link cannot be made.
- **Read-ahead of raw files.** A runtime asks for a raw installed file missing from its preload
  bundle with `?ahead=1` over its file channel; the host answers (status 207, the preload bundle's
  format) with it and the files after it in its directory by name, up to 512 KB (files over 64 KB
  and files the install's runs loaded before left out). The runtime keeps them until read (64 MB at
  most) with the name ranges answers covered, and a later miss asks only up to the next range
  (`&until=`).
- **Pushed modules for never-run installs.** A runtime asks for a transformed module with `?ahead=1`
  too; when its install has a prefetcher (never run), the host answers with the module and the
  modules it requires, and theirs, breadth first, whose transforms are done, each with its nearest
  `package.json`, up to 512 KB, each once per file channel (`HostRequest.channel`, the socket).
- **Only what a runtime reads is recorded.** For both, the runtime tells the host each file it reads
  from what came ahead (`?used=1`, a message it does not wait for), and the host records it as
  loaded, as if it had been asked for: later runs' preload bundles carry exactly what was read.
- **A lighter transform path on the host**: the source, the cached transform and raw files up to
  1 MB read synchronously (small files just written, in the page cache); a request answered once
  its transform is done, the transform kept "in progress" until it is on disk; cache directories
  made once per process; a package's "type" from the `package.json` files the install's index has,
  once per directory; the wrapper-clash check looks for let/const/class declarations of the
  wrapper's parameters in the converted code (var and function may redeclare a parameter, imports
  become vars). `Session.open` starts esbuild's synchronous and asynchronous services
  (`warmCompiler`) while Chromium launches.
- Tools: `scripts/profile.ts --cold`; `scripts/bench.ts` takes a directory of the checkout
  (`corpus/012-vite-react`) as a fixture.

## Consequences

- Cold runs, this ADR against origin/main (`scripts/bench.ts --base origin/main --modes cold`, both
  sides as refs, 3 interleaved rounds, medians, all 36 passed; warm `~/.npm` with trimmed entries):

  | Fixture | Total | Install | Start | Ready |
  |---|---|---|---|---|
  | vite-react-counter | 6.22 -> 4.94 s (-21%) | 2.74 -> 1.53 s | 1.36 -> 1.16 s | 0.94 -> 0.93 s |
  | lit-vite | 5.00 -> 4.10 s (-18%) | 2.28 -> 1.40 s | 1.03 -> 0.96 s | 0.54 -> 0.53 s |
  | astro-app | 21.58 -> 16.62 s (-23%) | 6.06 -> 3.64 s | 5.78 -> 4.27 s | 7.99 -> 7.18 s |
  | next-app-router | 21.26 -> 18.27 s (-14%) | 3.54 -> 3.48 s | 6.65 -> 4.98 s | 8.36 -> 7.72 s |
  | sveltekit-app | 14.40 -> 11.45 s (-21%) | 3.29 -> 1.86 s | 6.95 -> 5.44 s | 2.26 -> 2.21 s |
  | corpus/012-vite-react | 15.28 -> 9.99 s (-35%) | 3.34 -> 2.48 s | 1.01 -> 0.94 s | 9.06 -> 5.15 s |

  next-app-router's `Session.close` (the seed run beside it, ADR 0026) went 3.19 -> 4.40 s: the app
  finishes sooner and the seed run has more left; the run and its close together 24.45 -> 22.67 s.
  Warm runs are unchanged (same benchmark, `--modes warm`, all 24 passed): vite-react-counter 1.89
  -> 1.88 s, lit-vite 1.38 -> 1.34 s, next-app-router 5.10 -> 5.17 s, astro-app 5.15 -> 5.13 s.
- With npm's cache empty too (a new `npm_config_cache` each run, vite-react-counter, 2 rounds):
  13.3 -> 12.4 s, install 9.5 -> 8.7 s; the install waits for the registry, and there are no
  trimmed packuments to read yet.
- Each change's own A/B is in its commit message. The largest, cold runs (3 rounds, medians):
  - read-ahead: `corpus/012-vite-react` 14.36 -> 11.21 s (ready 8.81 -> 5.36 s);
  - trimmed packuments: `vite-react-counter` 6.36 -> 5.39 s (install 2.83 -> 1.68 s), `lit-vite`
    5.08 -> 4.34 s, `astro-app` 19.49 -> 18.11 s, `sveltekit-app` 13.76 -> 12.79 s (install 3.56 ->
    2.02 s);
  - `npm view` in the worker, linking, esbuild's services, the transform path (together, base
    2aa3a38): `astro-app` 19.01 -> 16.55 s (start 5.43 -> 4.27 s), `sveltekit-app` 12.36 -> 11.19 s,
    `next-app-router` 20.08 -> 19.30 s (start 6.33 -> 5.49 s), `vite-react-counter` 5.42 -> 4.95 s;
  - pushed modules: `next-app-router` 20.02 -> 18.61 s, `sveltekit-app` 11.18 -> 10.65 s,
    `astro-app` 16.59 -> 16.27 s; a cold `astro-app` start made ~430 file requests instead of
    ~1,470.
- Host installs (`Installer.install`, empty `.sandburg/`, npm loaded, warm and fresh `~/.npm`):
  `lit-vite` 2.51 -> 1.66 s, `vite-react-counter` 2.77 -> 1.66 s, `astro-app` 5.06 -> 3.79 s with
  trimmed packuments; peak RSS of an install `lit-vite` 735 -> 537 MB, `astro-app` 921 -> 690 MB.
  User CPU of an install, `npm view` in the worker: `astro-app` 7.11 -> 5.87 s.
- Lockfiles are byte-identical with and without trimmed packuments for all 18 fixtures and corpus
  000/001/009; install trees are identical with linked builds (paths, modes, sizes, sha1, link
  targets) for `astro-app`, `sveltekit-app`, `vite-react-counter`, `next-app-router`.
- **The first resolution that reads a packument version trims it**: about as long as before
  (`lit-vite` 3.04 -> 3.04 s, `astro-app` 6.03 -> 6.20 s), peak RSS +110-200 MB (the copies
  waiting for the helper and its parse). Trimmed entries took 100 MB of npm's cache for the 245
  packuments of the fixtures' installs; a packument that changes replaces its trimmed entry (the
  old content goes with `npm cache verify`, as npm's own). A machine whose npm cache was filled by
  plain npm (not Sandburg) reads full packuments in its first Sandburg resolution of them. The
  benchmarks above ran with trimmed entries present (the head side's earlier rounds made them; the
  base side does not read them), which is what every resolution after the first meets.
- **Behaviour.** Sandburg writes entries of its own into npm's cache (`sandburg:packument-trim:1:*`);
  `npm cache clean` removes them. No `npm view` processes are started. A runtime's first requests
  for raw and transformed installed files carry `?ahead=1`, and its use of files sent ahead
  `?used=1`; the host's answers can be bundles (207). Preload lists record what runtimes read, as
  before; files sent ahead and never read are not recorded. WebAssembly builds in installs are hard
  links to their side installs' files.
- **Memory.** A runtime holds up to 64 MB of files sent ahead until it reads them (unread ones stay
  until it ends). The host keeps, per file channel, the names it pushed (gone with the channel).

### Security

- **npm's cache.** Nothing new runs on the host or is fetched: npm resolves with its own code and
  options, `--ignore-scripts`. A trimmed packument is derived from bytes npm's cache verified (and
  that make-fetch-happen answered with), keyed by the cache entry it came from, used only while that
  entry's integrity is the one it was made from, and stored and read with cacache's integrity
  check. Who can write npm's cache can already change what npm resolves; no app reaches it. The
  store still checks every tarball's bytes against the lockfile's integrity. Tests
  (`test/unit/resolver.test.ts`): the lockfile from trimmed packuments is the CLI's; one planted for
  the same source is what npm resolves from (so it is what is read), one stored for another source
  is not read, one whose bytes changed on disk is refused and the full packument read.
- **The file channel.** Read-ahead and pushes answer on the same route (`/__sandburg/nm/<install>/`)
  and channel as single requests, which the host accepts only from the sandbox's own origin, and
  only with files of that install's index (directory listings come from the index; `rawSync` checks
  membership and refuses `..`; pushed transforms are the host's own of that install's files, found
  by the prefetcher's resolution over its index). `?used=1` records a load only for a path in the
  index; a recorded load only chooses which of an install's own files later bundles carry, as any
  request did. What was pushed is tracked per channel object (gone with the socket); nothing of one
  channel reaches another. Answers stay under the channel's 1 MB body limit. Tests:
  `test/unit/read-ahead.test.ts` (budget, `until`, large files, traversal, a path outside the
  install, pushes once per channel and only over a channel to a never-run install),
  `test/runtime/files.test.ts`.
- No new route, socket or cache shared across runs beyond npm's cache entries above (keyed by
  content digests, not by anything an app controls).

## What did not help

- **The first app of a Vite stack waiting for a seed run** (instead of pre-bundling itself, so that
  the second gets the seed): `corpus/003-vite-react` then `006` (same stack, fresh processes):
  first 17.6 -> 20.1 s, second 9.1 -> 4.0 s. A pair gains, every singleton pays the seed run's
  fixed costs (~2.5 s here); not kept (see Not done).
- **Transforming a whole install ahead**: every JavaScript file of `next-app-router`'s install
  (4,957 files, 93 MB) took 8.3 s on the host's 4 cores (16 at a time), against the ~1,700 a next
  dev start loads: the prefetcher's resolution stays.
- **Trimming at normal priority**: the first resolution of a packument took 0.3-0.7 s longer
  (`lit-vite` 2.63 -> 2.93 s, `astro-app` 5.37 -> 6.06 s); at the lowest priority it costs nothing
  measurable.
- **Read-ahead without the runtime's covered ranges**: esbuild reads out of order, and answers that
  each started at the asked file overlapped: ~540 KB and 50-90 ms of the host per answer (ready
  6.7 s instead of 5.7 s for `corpus/012-vite-react`).

## Not done

- **Vite seeds from the first app of an expensive stack.** A seed run beside (or right after) the
  first app whose pre-bundle is large (its `node_modules/.vite/deps` size says so) would let the
  second app of a pair start from it; it costs a seed run per stack (CPU in a batch).
- **The pre-bundle itself.** With its files read ahead, `corpus/012`'s lucide-react pre-bundle is
  5 s of esbuild's WebAssembly build in the runtime (with input source maps); Vite's optimizer runs
  the app's config and plugins, so it cannot move to the host's native esbuild. That is the
  frameworks' or runtime's work.
- **Prewarm for the corpus' stacks** (Vite 6 with React, Tailwind v4): `warmups()` covers Vite 8,
  Vite 8 with React and Next.js' App Router.
- **The install's file index from the store** (ADR 0035): still a walk of `node_modules` after the
  install (20-170 ms); builds and shims change files after linking, so the walk stays the truth.
- **Next.js's unpack** (192 MB, ~3 s, disk-bound per ADR 0035) bounds a cold Next.js install;
  serving a package's files from its tarball without unpacking them would change how installs are
  read everywhere.
- Side installs still resolve in the install's worker (ADR 0035).
