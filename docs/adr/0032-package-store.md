# ADR 0032: A package store and a long-lived resolver for host installs

- Status: Accepted
- Date: 2026-10-23

## Context

A cold run (empty `.sandburg/`, warm `~/.npm`) spent most of its install phase in
`npm install --ignore-scripts --omit=optional` on the host. npm's timing (`--timing`) and a CPU
profile of `fixtures/next-app-router`'s install (14.7 s on a 4-core machine) showed two halves:

- **Resolution, 2.5–4 s for any app.** It barely depends on the network: with `--offline` it takes as
  long. npm 10 reads full packuments from its cache, and about two thirds of the CPU goes to
  `JSON.parse`, decoding them and checking their integrity. Most of what it parses comes from peer
  checks: a new package that peers on Vite makes npm read Vite's packument (39 MB) and those of
  Vite's optional peers and theirs (vitest, playwright at 17 MB, webdriverio, happy-dom, …), none of
  which are installed. npm keeps packuments in memory only for one run, and none over 1 MB.
- **Unpacking, 9.2 s for Next.js alone** (`reifyNode:node_modules/next`). node-tar takes 9.1 s for
  Next.js's 43 MB tarball (8,700 files), where GNU tar takes 1.4–2.4 s and a synchronous loop
  (gunzip, then a write per file) 2–4 s on this machine's disk. Every install unpacked its packages
  again, unless it started from a closest install (`cp -al`, Linux only, at least half of its
  dependencies the same).

After npm, the WebAssembly builds and napi-rs bindings (ADR 0026) each ran `npm install` in a side
directory: ~1 s for every Vite 8 app (lightningcss-wasm, `@rolldown/binding-wasm32-wasi`, an
`npm view` for `lightningcss-wasm32-wasi`, which does not exist), several seconds for Angular and
Astro apps, the same answers each time.

## Decision

- **npm resolves, a store unpacks** (`src/adapters/node/package-store.ts`). npm writes the lockfile
  (`npm install --package-lock-only`, the same lockfile a full install writes, checked). Each package
  of the lockfile that `--omit=optional` keeps is unpacked once into `.sandburg/store/<integrity>/`,
  from npm's cache by its integrity (checked against the tarball's bytes), on four worker threads,
  streaming (files are written as gunzip produces them, in 1 MB pieces), and hard-linked into each
  install (copied where links cannot be made). What lands in `node_modules` is what npm writes: the
  same files, bytes and modes (pacote: links and directories in tarballs skipped, `.gitignore` as
  `.npmignore`, the tarball's modes), `.bin` links in bin-links' order (by depth, then path; the
  first package wins a name; a linked binary made executable and without a CRLF after `#!`, as the
  install's own copy when that changes the store's file), npm's hidden lockfile, and the empty scope
  directories npm leaves for omitted packages. Tree diffs (paths, modes, sizes, hashes, link
  targets) against npm's installs of all 17 fixtures are empty. A lockfile with links, git
  dependencies or shrinkwraps, or a tarball still missing from npm's cache after `npm cache add`,
  goes to `npm install` as before.
- **The closest install lends its lockfile, not its files.** npm then resolves only the
  difference, as before; the store shares the files on every platform. Installed in sequence, npm's
  start from a closest install (`cp -al`) had left empty directories and `.bin` links of the install
  it copied (angular-zone's `.bin/esbuild` pointed to esbuild-wasm, where npm alone links esbuild);
  those are gone.
- **Unpacking starts while npm resolves**: the packages of the lockfile an install starts from (the
  project's own, or the closest install's), and dependencies pinned to a version whose tarball npm's
  cache has (`"next": "16.4.2"`, found through npm's cache index by the tarball URL), on two threads.
  A guess costs only CPU: an install takes a package from the store only when its lockfile names that
  integrity.
- **npm resolves in a worker that lives across installs** (`src/adapters/node/resolver.ts`), with
  npm's own code: the npm on PATH, whose `lib/npm.js` loads the configuration as the CLI does in an
  install directory (the same flags, user, global and environment settings, a local prefix without an
  `.npmrc`, Node's compile cache), and whose Arborist writes the lockfile as `npm install
  --package-lock-only` does, with a packument cache that keeps large packuments (96 MB of them, by
  their size on the wire). Lockfiles are the same as the CLI's. Another npm layout, Windows, an error,
  or a resolution already running sends the install to the CLI; the worker ends after 30 s without
  installs.
- **WebAssembly side installs** start from the resolved lockfile (its versions and optional
  dependencies), beside the unpacking. They resolve in the resolver (small resolutions run beside
  others) and come from the store; one whose lockfile has optional packages (sass's
  `@parcel/watcher`) is installed by `npm install` from its package.json, as before (npm installing
  from a lockfile skips its libc check for optional packages). They are kept
  (`.sandburg/side-installs`, by package.json, flags and layout) as installs are: the versions npm
  picks first stay. The bindings an install lists are installed while `npm view` checks the rest;
  when one of those exists, all are installed as one tree, as before.
- **The store is swept** with old installs: packages no install links any more (their
  `package.json` has no other link), a day after they were unpacked.

## Consequences

- Cold runs, this ADR against origin/main (`scripts/bench.ts --modes cold,warm`, 3 interleaved
  rounds, medians, all passed): `next-app-router` 41.0 s → 32.9 s to the result (install phase
  13.0 s → 4.9 s; `Session.close`, which waits for the Next.js seed run, 5.7 s → 6.9 s),
  `vite-react-counter` 12.2 s → 11.1 s (install 5.7 → 4.5 s), `lit-vite` 10.8 s → 9.9 s (install
  5.2 → 4.1 s). Warm runs' install phases are unchanged (0.3–0.6 s); their totals moved by −12%,
  −1% and +8% (`next-app-router` 6.95–8.16 s against 7.42–7.67 s, in start and ready, not in the
  install).
- Host installs in sequence in one process (corpus 000, 001, 002, 003, 004, 007, 009, then lit-vite
  and next-app-router; empty `.sandburg/`, warm `~/.npm`, 3 rounds), store only: 55.6 s → 30.5 s,
  Next.js apps 14.6 s → 5.7 s each. The resolver then took the same sequence from 30.8 s to 28.3 s
  (6 rounds), and resolution alone of a Vite app after others from 2.3–4.0 s to 0.4–0.7 s.

- npm's resolution is still most of a first install: 2.5–4 s even for a 20-package app. What
  shortens it is a lockfile (the project's, or the closest install's) or packuments the resolver
  already holds.
- **Memory.** The resolver's worker keeps the heap of its largest parse until it ends: over a
  sequence of seven installs, the peak RSS of the host and its npm processes went from 1,055 MB
  (store, no resolver) to 1,636 MB; a cache budget of 64–160 MB changes that little. Streaming the
  unpack took it back by ~500 MB (1,620 → 1,115 MB). On origin/main the same sequence peaked at
  580 MB, in npm processes that end after each install.
- `.sandburg/store` keeps the packages installs have (Next.js's is ~140 MB): deleting an install
  frees only its links. Files are shared by hard links, so the rule that an install's files are
  replaced, never written in place (`replaceFile`), now covers the store as well.
- The host's npm output for installs is gone from the run logs ("added 22 packages in 15s"): the
  resolver and the store print nothing unless they hand an install back to npm.
- The resolver depends on npm's internal layout (`lib/npm.js`, `@npmcli/arborist`, the flat options);
  an npm that changes them makes installs use the CLI again, slower but the same.
- Side installs are no longer resolved again for each install: a newer `@napi-rs/wasm-runtime`
  reaches installs once `.sandburg/` is cleared or the layout changes, as with installs themselves.
