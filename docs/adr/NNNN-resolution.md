# ADR NNNN: npm's resolution, read ahead; unpacking and side installs as it goes

- Status: Accepted
- Date: 2026-10-24

## Context

After ADR 0032 (a package store, a long-lived resolver), the host's half of a never-run app's
install was mostly npm's resolution (`npm install --package-lock-only` in the resolver's worker),
then what only started once the lockfile was there. Host installs (`Installer.install`, empty
`.sandburg/`, warm `~/.npm`) on a 4-core machine: lit-vite 3.4 s, of which 2.2 s resolution;
vite-react-counter 3.8 s (2.6 s); astro-app 6.9 s (4.1 s); next-app-router 5.2 s (2.8 s, and
Next.js's own unpack, 3 s of writing 192 MB, beside it).

- **Stale cache entries, one after the other.** npm reads a package's peers in turn
  (build-ideal-tree's `#loadPeerSet`), and a cached packument older than the registry's max-age (5
  minutes on npmjs.org) waits for the registry to revalidate it (a 304). lit-vite resolved in
  2.0 s with every entry fresh and 4.1 s with every entry stale (`--prefer-online`); astro-app in
  3.5 s and 10.3 s. A machine whose last install was more than 5 minutes ago pays that on its first
  install; an A/A run of `scripts/bench.ts` showed it too (the first cold install of a round,
  4.26 s, against 2.76 s for the next).
- **CPU, on one thread.** With every entry fresh, the resolver's thread is busy all the time:
  lit-vite's resolution reads 129 MB of full packuments (Vite's alone is 39 MB, 35 MB of it a
  license text in each version; playwright 17 MB, typescript 16 MB, `@types/node` 11 MB), mostly
  for peers that are never installed: `JSON.parse` 0.6 s, decoding 0.3 s, garbage collection 0.27 s,
  cacache's integrity check 0.23 s, of 2.35 s.
- **Serial after the lockfile.** The store unpacked ahead only the starting lockfile's packages and
  pinned dependencies; everything else (0.5–1.4 s for lit-vite, astro-app, sveltekit-app) waited
  for the lockfile. The WebAssembly bindings waited for an `npm view` process per candidate binding
  (~0.5 s each, revalidating with the registry), and were the last step of the install for lit-vite
  and sveltekit-app, 0.8–1.2 s after the resolution.
- **npm loaded on the first install.** A first resolution in a process waited ~0.5 s for the
  worker to start, load npm and Arborist and compile Arborist's code.

## Decision

- **The resolver reads ahead the stale packuments npm will ask for next** (`ReadAhead` in
  `src/adapters/node/resolver.ts`). As each manifest comes back to npm, the packuments of the
  packages it brings in are read, four at a time, into the packument cache npm reads from, with
  pacote's own code and the options npm asks with: the same requests (revalidated with the
  registry, as npm would), only earlier. Only entries npm would revalidate are read ahead: older
  than their Cache-Control max-age, without one, or all of them with `--prefer-online` (none
  offline or with `--prefer-offline`). A fresh entry is left to npm: reading it ahead only moved
  npm's parsing earlier on its own thread, ahead of the small packuments it was waiting for
  (next-app-router's install phase went 4.45 → 5.47 s in a cold run). pacote gets a packument being read ahead as a promise from the cache; one
  that fails is read again for it; a packument pacote is reading itself is not read again. What is
  read follows npm's rule: a package npm places has its dependencies, optional dependencies and
  peers loaded; one it loads only as an optional peer (Vite's vitest, vitest's playwright) only
  its peers, unless something depends on it; a dependency's dev dependencies never. Only
  packuments npm's cache has are read ahead: a wrong guess never fetches a package npm has not
  fetched before. For astro-app with every entry stale, 296 packuments were read ahead, one of
  which npm did not ask for.
- **Packages are unpacked as npm picks them.** The resolver's worker reports each package npm
  places (its name, version, integrity and optional dependencies); the host unpacks it into the
  store when npm's cache has its tarball (`unpackHint`, on the two threads that unpack ahead), asks
  whether its napi-rs bindings have a WASI build (`npm view`, kept per spec and process as before),
  and starts the side install of its WebAssembly build (kept per package.json as before). All are
  guesses, as ADR 0032's unpacking ahead: an install takes a package from the store only when its
  lockfile names that integrity, and the store checks the tarball's bytes against it. An install
  takes onto its own four threads the packages still waiting for one; what it does not need is no
  longer unpacked.
- **A session loads npm while the browser launches.** `Session.open` calls the default adapter's
  `prepare()` (new on `AdapterDescriptor`) before Chromium launches; the node adapter starts the
  resolver's worker, which loads npm and resolves an empty project.

## Consequences

- Cold runs, this ADR against origin/main (`scripts/bench.ts --modes cold`, both sides as refs,
  3 interleaved rounds, medians, all passed):

  | Fixture | Total | Install phase |
  |---|---|---|
  | vite-react-counter | 10.15 → 7.53 s (−26%) | 5.78 → 2.96 s (−49%) |
  | astro-app | 27.30 → 23.13 s (−15%) | 10.85 → 6.13 s (−43%) |
  | lit-vite | 6.50 → 6.16 s (−5%) | 3.14 → 2.68 s (−14%) |
  | next-app-router | 24.98 → 25.33 s (+1%) | 4.75 → 4.51 s (−5%) |

  The rounds of the base that came after a pause paid for stale cache entries (install phases
  vite-react-counter 5.8, 3.2 and 5.8 s; astro-app 10.9, 7.0 and 10.9 s), those of this branch
  less (3.4, 2.8 and 3.0 s; 6.4, 6.1 and 5.7 s): what a never-run app meets on a machine that
  installed nothing in the last minutes. next-app-router's install waits for Next.js's own unpack
  (3 s of writing 192 MB) as much as for npm; its total moved within noise (start and ready).
- Host installs (`Installer.install`, empty `.sandburg/`, warm `~/.npm`), interleaved, 4 rounds,
  medians, per commit: the unpacking as npm picks packages took sveltekit-app 4.74 → 4.30 s,
  lit-vite 3.51 → 3.27 s, astro-app 6.49 → 6.33 s (vite-react-counter unchanged); asking about
  WebAssembly builds as npm picks packages sveltekit-app 4.40 → 4.09 s, lit-vite 3.38 → 3.21 s,
  vite-react-counter 3.88 → 3.76 s. Loading npm as a session opens: install phase of a cold run
  lit-vite 2.87 → 2.55 s, vite-react-counter 3.53 → 3.03 s (3 rounds).
- Resolution alone (fresh process each, warm `~/.npm`; next-app-router, lit-vite and astro-app in
  turn), 3 interleaved rounds, medians: with every cache entry stale (`--prefer-online`), lit-vite
  3.59 → 2.28 s, astro-app 9.72 → 6.42 s, next-app-router (the first of the process) 4.25 →
  4.18 s; with every entry fresh, unchanged (2.75 → 2.78 s, 1.68 → 1.72 s, 3.83 → 3.83 s).
- Host installs in sequence in one process (corpus 000, 001, 002, 003, 004, 007, 009, then lit-vite
  and next-app-router; empty `.sandburg/`, warm `~/.npm`), 3 rounds, before the read-ahead was
  limited to stale entries: total 22.6 → 19.4 s, peak RSS 1,032 → 1,027 MB.
- Lockfiles are the same as before for all 17 fixtures, and the trees of lit-vite, astro-app and
  next-app-router (paths, modes, sizes, sha1, link targets). A unit test runs a local registry whose
  entries are always stale (so each read reaches it), with a package only an optional peer depends
  on already in npm's cache: the resolver writes the CLI's lockfile and reads exactly the
  packuments the CLI reads (it fails without the optional-peer rule).
- **Behaviour.** A session starts npm's resolver worker when it opens, also for runs that never
  install on the host (it ends after 30 s without installs). A side install started from the
  resolver's report writes no log lines into the run's log (only a fallback to the npm CLI would).
  A stale packument is revalidated a little earlier than npm would; the registry is asked the same
  questions.
- **Memory.** Unchanged for one install (no new threads during the resolution); the two threads
  that unpack ahead start earlier (peak RSS of single installs 681 → 727 MB, medians of 16).

### Security

- npm still resolves with its own code and options, `--ignore-scripts`; nothing new runs on the
  host. The read-ahead makes the requests npm makes (pacote's own fetcher, npm's flat options),
  only for packuments npm's cache already has, so it reaches only the registry npm uses, and no
  package npm has not fetched before (the unit test counts the registry's requests).
- The resolution's result is npm's: the read-ahead only fills the cache npm reads from, with what
  npm would have read; the lockfile tests above compare the CLI's.
- The store's rules are ADR 0032's: a package reported by the resolver is a guess; the tarball comes
  from npm's cache by integrity, its bytes are hashed and checked before the directory goes into the
  store, and an install takes a package only when its own lockfile names that integrity. A test
  reports a tarball whose bytes are not what its integrity names: it never reaches the store, and
  the install of it is refused as before.
- No cache is shared across runs that was not before; nothing is keyed by names an app controls.

## What did not help

- **Packuments in helper threads.** Each package name's `pacote.manifest` ran in one of 3–6 helper
  threads, which sent back only the picked manifest, with the same read-ahead. Same lockfiles, and
  faster: fresh, next-app-router 2.5 → 1.9–2.3 s, astro-app 4.0 → 3.1–3.4 s; stale, astro-app 10.3
  → 4.6–5.0 s. But peak RSS of a lit-vite install went 608 → 992 MB (each isolate parses its own
  packuments and keeps its garbage until it allocates again); collecting a helper's garbage when it
  went idle, and 3 helpers, brought it to ~790 MB, where the fresh-cache gain was within noise.
  Without the optional-peer rule, the read-ahead read 257 packuments for lit-vite's 82 (and, from
  an earlier version, fetched them from the registry), and was slower than none.
- **Reading ahead in npm's thread without the optional-peer rule**: fresh lit-vite 2.1 → 3.3 s.
  With it, but fresh entries too: next-app-router's host install 3.49 → 3.96 s (5 rounds), its
  resolution 0.3–0.5 s longer beside Next.js's unpack.
- **A larger young generation** for the resolver's worker (`maxYoungGenerationSizeMb` 32–128):
  astro-app 3.82 → 3.52 s in one series, unchanged when interleaved.
- **Abbreviated ("corgi") packuments** are 7–17× smaller (Vite 2.3 MB against 39 MB) but have no
  `license`, which npm's lockfile records (npm asks for full packuments for that), nor `time`.
- **Parallel writes of one tarball** (Next.js's 8,690 files, 192 MB, from memory): 2.8 s with
  synchronous writes, 2.2–2.6 s with 4–16 asynchronous ones; disk-bound either way.

## Not done

- A derived cache of manifests (pacote.manifest's result, by the cacache integrity of the
  packument it came from, the spec and the options), for later processes: exact by construction,
  but only when make-fetch-happen would answer from its cache without the registry, which needs
  its freshness rules reproduced; it would not show in cold runs (`.sandburg/` is empty).
- Side installs resolve in the same worker as the install's own resolution, and so finish only
  after it (1.1 s for lightningcss-wasm started 0.6 s before the resolution ended); a second worker
  for small resolutions would cost another npm in memory.
- The file index of a never-seen install walks node_modules after it is made (20–130 ms); the store
  knows the files as it links them.
