# ADR 0016: Fail-fast checks, shared Vite seeds, warm-ups

- Status: Accepted
- Date: 2026-09-30
- Measured in: [fidelity study v6](../fidelity/v6-node-vs-truth.md)

## Context

Study v5 showed where a batch's time went after the cold-start work in
[ADR 0014](0014-node-runtime-only.md):

- Failing apps' checks were 35% of the warm pass: every failing assertion waited its full 20 s.
- The first vite-react apps spent up to a minute pre-bundling dependencies (esbuild's WebAssembly
  build, one thread), each app on its own.
- The first app of each stack paid for npm and, for Next.js, the webpack seed, often in several
  tabs at once.

## Decision

**Assertions stop waiting when nothing can change them** (`settlingExpect` in
`src/orchestrator/checks.ts`). A web-first assertion first waits 5 s. While it keeps failing, it
retries in 1 s slices up to its timeout, and fails as soon as the app is idle between two slices.
Idle means:

- no request to the runtime's servers is in flight, and the runtime has been quiet for 1.5 s
  (`NodeProcess.activity()`, reported by the host page);
- the app's page has no `setTimeout` due before the assertion's time is up, and has not changed
  for 1.5 s. A script that runs first in every document of a run (`PAGE_QUIET_SCRIPT`) tracks the
  page's timeouts and DOM changes.

A dev server compiling a route keeps a request open, so a route that takes 15 s to compile still
passes, and so does a page that updates itself from a timer. An assertion with its own `timeout`,
and `expect.poll`/`soft`, keep Playwright's behavior with the configured timeout. The error says why
the assertion stopped. Runtimes without a host page (the Docker reference) wait the full timeout as
before, and `RunOptions.failFastChecks: false` turns this off.

**Vite pre-bundling seeds** (`src/adapters/node/vite-seed.ts`). What Vite pre-bundles depends on
the installed packages, the settings (package.json, lockfile, the Vite config and the files it
imports, tsconfig, `.env`) and which packages the app's browser code imports, found from its HTML
as Vite's scan finds them. It does not depend on the app's own code. Apps that agree on all of
these share one cache.

The cache comes from a seed project that the session runs itself: those settings, plus an entry
that imports the same packages and never calls them. Everything in the seed is part of the key, so
what a seed run produces is a function of its key. An app's own run never writes to a shared cache:
its page runs the app's code (ADR 0014).

The second app with a key starts the seed run, beside it. No app waits for a seed: one that has
none pre-bundles on its own, as before, in about the time a seed run would take. Apps after the seed
is stored start from it. Apps with their own cache from an earlier run keep using it, and
`optimizeDeps` settings opt a project out. (Study v6 measured an earlier version in which the
second app waited for the seed. In a batch of ten copies of one app, eight tabs at a time, that
made seven apps wait about 10 s each for a seed of packages they could pre-bundle in 1–2 s.)

**Warm-ups** (`src/adapters/node/warmup.ts`, `Session.prewarm`). Batches and `compare` first run
small Vite, Vite + React and Next.js projects, side by side, when their installs are missing. They
use 60 s start and ready timeouts. Later apps of those stacks start from their installs (npm
installs only the difference), transforms, preloads, and the Next.js seed for their versions. On a
warm machine this only checks for the installs. `--no-prewarm` turns it off.

**Render check.** An app whose `#root`/`#app` holds only text now counts as rendered. It timed out
before: the warm-up found this.

## Consequences

- The cold corpus went from 613 s to 533 s, and the warm corpus from 361 s to 289 s, with the same
  answers. Checks take half as long.
- A failing assertion in an app that keeps its servers or its page busy (polling, a stream, a timer
  loop) still waits its full timeout. An app that changes itself later with no request, no pending
  timeout and no change in between (an interval, a WebSocket message, a worker) can still fail an
  assertion early. Checks for such apps can pass a `timeout` to the assertion, and runs can turn
  this off.
- Seeds share little in a corpus where most apps differ in their packages. The benefit grows with
  apps generated from the same template.
- The warm-up versions (Vite 6, React 19, Next.js 15) should follow what generated apps use.
