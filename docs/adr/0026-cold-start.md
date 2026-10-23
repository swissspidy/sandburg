# ADR 0026: Cold starts

- Status: Accepted
- Date: 2026-10-23

## Context

A cold run (empty `.sandburg/`, warm `~/.npm`) had no preload list: the runtime asked for each
installed file in turn (~1,300 for next dev, ~200 for Vite), and each request waited for its file's
transform while the host's other cores idled. Ahead of that, the run waited for steps that did not
depend on each other: the tab loading before the host's npm install began, the runtime's bundle built
only once the install was done, the WebAssembly builds and bindings added one after another. The
first Next.js app waited for its seed run (ADR 0014), about 40 s, before its own install phase ended.

## Decision

- **The host predicts a never-run install's first preload bundle** (`src/adapters/node/prefetch.ts`).
  From the program's entry (the dev script's bin, or `require('next')`) and from each file the runtime
  asks for, it finds the requires in the transformed code (ES imports and `import()` are require calls
  there), resolves them as the runtime's loader does (relative paths, `node_modules`, `exports` with
  the same conditions, `main`, `index`) and transforms them three at a time. A request for a file in
  progress waits for that transform. The bundle is what it found when the bundle is asked for (and up
  to 8 s after, or until it is done), plus what other installs' runs loaded from the same package
  versions; its files are recorded as loaded, so later runs preload them as before. A guess is only a
  transform made early: the runtime still resolves and loads every module, and asks for what the
  bundle misses.
- **Independent steps run side by side**: the host's install starts as soon as the probe passes,
  while the tab loads; the runtime's bundle is built before npm runs; the SWC copy, napi-rs WASI
  bindings and WebAssembly builds are added together, with `npm view` answers kept per process.
- **Transforms of installed files are kept in memory**, by install and path, up to 256 MB, least
  recently used out first (an install does not change once it is made).
- **The first Next.js app does not wait for its seed run**: as with Vite seeds (ADR 0016), the seed
  runs beside the app, which compiles Next.js on its own; later apps start from the seed.
  `Session.close` and prewarm wait for seed runs in progress.
- Smaller host costs: CommonJS names renamed in one pass (1.2 s on Vite 8's node chunk before), and
  the install index walked synchronously.

## Consequences

- Cold runs on an idle 4-core machine, with ADRs 0025 and 0027: `fixtures/next-app-router`
  89.3 s → 32.0 s to the result (plus ~5.7 s in `Session.close` for the seed), `vite-react-counter`
  12.9 s → 9.3 s, `lit-vite` 10.8 s → 8.7 s. Each change's own measurement is in its commit message.
- **A never-run install can wait up to 8 s for its first bundle**, while the prediction runs; static
  resolution also finds requires behind conditions (for next dev 1,664 files, 792 of the 853 its runs
  load), whose transforms are cached and cost bundle space.
- **A one-off CLI run of a Next.js app ends when the seed is stored**, a few seconds after its result.
- The host holds up to 256 MB of transforms.
