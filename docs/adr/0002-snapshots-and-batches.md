# ADR 0002: Snapshot-based project input, batches, and proof of network containment

- Status: Accepted (milestone 2)
- Date: 2026-09-29

## Context

Two later ideas depend on how project input is identified:

- a step-through viewer that shows an agent's app after each step, and
- "click to verify" links that reproduce a reported result.

Both come down to "load exactly this file tree in a tab". If projects are
identified by where they came from (a path, a temp dir), both need a retrofit
later. If projects are identified by their content, both are a lookup.

Milestone 2 also asks for parallel batches of 8+ tabs with a shared cache and
a test that proves the network is blocked except for the mirror.

## Decision 1: Projects are content-addressed snapshots

- `src/store.ts` keeps a blob store (file bytes under their sha256) and
  snapshot manifests (path → blob hash). A snapshot id is the sha256 of the
  canonical manifest (`path\0blob\n` lines in sorted order). The same tree
  always gets the same id, whatever its source, and the id is stable across
  machines.
- Every run stores its snapshot first. `result.project.snapshotId` replaces
  `contentHash`, since the two were the same idea. This changes schema v1
  before anything consumes it, so the version stays 1.
- `snapshot:<id or unique prefix>` works as project input everywhere
  (`run`, `batch` items, `open`, the library). `sandburg snapshot <dir>`
  stores a tree and prints its id. `sandburg open <project>` loads a project
  in a visible tab and keeps it open. This is the viewer's primitive.
- Names are informational and not part of the id. The first writer wins.
- An agent trajectory is a list of snapshot ids, one per step. Consecutive
  steps share most blobs, so a trajectory costs about one project plus the
  diffs. Lineage (parent, step number, note) belongs in the harness that
  produces the steps, not in the id. We will add a small trajectory file
  format when the viewer lands.
- Reading verifies each blob's hash, so a corrupted store fails loudly.

## Decision 2: Batches share one browser, one gateway and one cache

- `runBatch(session, items, { parallel })` runs a worker pool over one
  `Session`. Each run gets its own browser context, tab and origin
  (ADR 0001). A project directory's own `checks.spec.ts` becomes its checks.
- The batch writes `summary.json` (schema version 1): totals by status and
  failure class, cache hits and misses, blocked requests, wall time and
  `speedup` (the sum of per-run time divided by wall time).
- Measured on a 4-core container: 10 variants of the fixture with 8 tabs at
  a time finished in 9.8 s wall time. Each run took 4.2 to 8.7 s under
  contention (2.2 s alone), for a speed-up of 6.9x. All 150 CDN requests
  were cache hits.
- Isolation is tested: each app reads a `localStorage` key that the other
  apps write, and it must find nothing.

## Decision 3: Network containment is proved, not assumed

The test (`test/e2e/batch.test.ts`) starts a loopback TCP "canary" server. An
app then tries every way to reach it and `example.com`: `fetch`,
`sendBeacon`, `<img>`, `<script>`, `<iframe>`, `EventSource` and `WebSocket`,
via `127.0.0.1`, `localhost` and `[::1]`. The test asserts:

1. **With the gateway:** the canary gets zero connections, and each attempt
   is recorded in `network.blocked`, WebSockets included. The gateway now
   also routes WebSockets (`context.routeWebSocket`), which HTTP routing does
   not see. They are allowed only to the sandbox origin.
2. **Backstop only:** a page on a sandbox origin, in a browser with
   Sandburg's launch options but no gateway routing, still reaches the
   canary zero times, while the sandbox origin itself stays reachable.
3. **Control:** the same attempts from a browser launched without the dead
   proxy *do* reach the canary. Without this control, test 2 could pass
   without proving anything.

The "mirror" for milestone 2 is the gateway's cache in front of the
adapter's allowlisted origins. almostnode loads packages from esm.sh, so
there is no npm tarball traffic to mirror yet. Adapters that install from
npm (Nodebox, the Docker reference) plug the registry in as another
allowlisted, cached origin.

## Consequences

- The viewer, verify links and trajectory replays need no new storage.
- The store grows without bound. Garbage collection (dropping blobs that no
  snapshot references) is simple to add when it matters.
- Parallelism is bound by CPU: esbuild-wasm transforms run in every tab.
  Past about 2 tabs per core, per-run time rises about as fast as
  throughput does.
