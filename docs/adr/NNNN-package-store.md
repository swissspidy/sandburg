# ADR NNNN: A package store for host installs

- Status: Accepted
- Date: 2026-10-23

## Context

A cold run (empty `.sandburg/`, warm `~/.npm`) spent most of its install phase in
`npm install --ignore-scripts --omit=optional` on the host. npm's timing (`--timing`) and a CPU
profile of `fixtures/next-app-router`'s install (14.7 s on a 4-core machine) showed two halves:

- **Resolution, 2.5–4 s for any app.** It barely depends on the network: with `--offline` it takes as
  long. npm 10 reads full packuments from its cache (Vite's is 39 MB, TypeScript's 16 MB,
  Playwright's 17 MB, fetched for optional peers), and about two thirds of the CPU goes to
  `JSON.parse`, decoding them and checking their integrity.
- **Unpacking, 9.2 s for Next.js alone** (`reifyNode:node_modules/next`). node-tar takes 9.1 s for
  Next.js's 43 MB tarball (8,700 files), where GNU tar takes 1.4–2.4 s and a synchronous loop
  (gunzip, then a write per file) 2–4 s on this machine's disk. Every install unpacked its packages
  again, unless it started from a closest install (`cp -al`, Linux only, at least half of its
  dependencies the same).

After npm, the WebAssembly builds and napi-rs bindings (ADR 0026) each ran `npm install` in a side
directory: ~1 s for every Vite 8 app (lightningcss-wasm, `@rolldown/binding-wasm32-wasi`, an
`npm view` for `lightningcss-wasm32-wasi`, which does not exist), the same answer each time.

## Decision

- **npm resolves, a store unpacks** (`src/adapters/node/package-store.ts`). npm writes the lockfile
  (`npm install --package-lock-only`, the same lockfile a full install writes, checked). Each package
  of the lockfile that `--omit=optional` keeps is unpacked once into `.sandburg/store/<integrity>/`,
  from npm's cache by its integrity (checked against the tarball's bytes), on four worker threads,
  and hard-linked into each install (copied where links cannot be made). What lands in
  `node_modules` is what npm writes: the same files, bytes and modes (pacote: links and directories
  in tarballs skipped, `.gitignore` as `.npmignore`, the tarball's modes), `.bin` links in
  bin-links' order (by depth, then path; the first package wins a name; a linked binary made
  executable and without a CRLF after `#!`, as the install's own copy when that changes the store's
  file), npm's hidden lockfile, and the empty scope directories npm leaves for omitted packages. Tree
  diffs (paths, modes, sizes, hashes, link targets) against npm's installs of all 17 fixtures are
  empty. Installed in sequence, npm's start from a closest install (`cp -al`) had left empty
  directories and `.bin` links of the install it copied (angular-zone's `.bin/esbuild` pointed to
  esbuild-wasm, where npm alone links esbuild); those are gone. A lockfile with links, git dependencies or shrinkwraps, or a
  tarball still missing from npm's cache after `npm cache add`, goes to `npm install` as before.
- **The closest install lends its lockfile, not its files.** npm then resolves only the
  difference, as before; the store shares the files on every platform.
- **Unpacking starts while npm resolves**: the packages of the lockfile an install starts from (the
  project's own, or the closest install's), and dependencies pinned to a version whose tarball npm's
  cache has (`"next": "16.4.2"`, found through npm's cache index by the tarball URL), on two threads.
  A guess costs only CPU: an install takes a package from the store only when its lockfile names that
  integrity.
- **WebAssembly side installs** start from the lockfile (its versions and optional dependencies),
  beside the unpacking, and are kept (`.sandburg/side-installs`, by package.json, flags and layout)
  as installs are: the versions npm picks first stay. The bindings an install lists are installed
  while `npm view` checks the rest; when one of those exists, all are installed as one tree, as
  before.

## Consequences

- Cold runs (`scripts/bench.ts --modes cold`, 3 interleaved rounds, medians, before the side-install
  cache, which a single run does not use): `next-app-router` 45.7 s → 39.3 s (install phase
  14.3 s → 5.9 s), `vite-react-counter` 13.3 s → 12.1 s (5.6 → 5.2 s), `lit-vite` 11.6 s → 11.2 s
  (5.5 → 4.6 s). The host's install alone of `next-app-router`: 14.6 s → 6.4 s.
- Installs in sequence in one process (corpus 000, 001, 002, 003, 004, 007, 009, then lit-vite and
  next-app-router; empty `.sandburg/`, warm `~/.npm`, 3 rounds): 55.6 s → 30.5 s, Next.js apps
  14.6 s → 5.7 s each, a Vite vanilla app 2.4 s → 0.9 s.
- npm's resolution is now most of a cold install: 2.5–4 s even for a 20-package app. A shared
  lockfile (the project's, or the closest install's) is what shortens it.
- `.sandburg/store` keeps the packages installs have (Next.js's is ~140 MB): deleting an install
  frees only its links. Installer's sweep removes, a day after they were unpacked, packages no install
  links any more. Files are shared by hard links, so the
  rule that an install's files are replaced, never written in place (`replaceFile`), now covers the
  store as well.
- Side installs are no longer resolved again for each install: a newer `@napi-rs/wasm-runtime`
  reaches installs once `.sandburg/` is cleared or the layout changes, as with installs themselves.
