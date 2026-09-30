# Fidelity study v5: the node runtime after the cold-start work, vs ground truth

Run 2026-09-30 on the same 4-vCPU machine as v4, 3 tabs at a time, after the cold-start work in
[ADR 0014](../adr/0014-node-runtime-only.md): shared transforms and preloads, seeded Next.js webpack
caches, installs that start from a similar one, and the runtime fixes (in-place writes, native UTF-8
and zlib). The cold pass starts from empty Sandburg stores (installs, transforms, preload lists,
seeds; npm's own download cache was warm, as in v4); the warm pass runs the same 100 apps again.
Data: [`v5-node-vs-truth.json`](v5-node-vs-truth.json) (the cold pass).

## Against ground truth

Both passes gave the same answers as v4 (and v3) on every app: **97/100 right, no false alarms**. The
misses are the same three mislabelled apps (054, 078, 084: `nanoid` is hoisted by npm). All 27 caught
faults are classified `app-bug`, by the same rules as in v4.

## Time

| Framework | v4 median (cold) | v5 median, cold | v5 median, warm |
|---|---|---|---|
| vite-vanilla | 3.9 s | 3.7 s | 3.3 s |
| vite-react | 33.0 s | 19.6 s | 5.7 s |
| nextjs | 40.4 s | 16.2 s | 13.9 s |
| All | 28.9 s | 14.4 s | 6.8 s |

The whole corpus took 613 s (cold) and 361 s (warm) of wall time with 3 tabs.

Where the time goes now:

- **Failing apps wait for their checks to time out.** In the warm pass the slowest runs are all apps
  whose checks fail: an assertion waits up to 20 s (the node runtime's `expect` timeout, chosen when
  next dev compiled a route in ~10 s). Checks are 35% of the warm pass (369 of 1,067 s summed over
  runs).
- **First runs of a stack pay once.** The first Next.js app waited 93 s in install (npm and the seed
  run for its versions); the first vite-react apps spent 57–60 s in ready (Vite 6 pre-bundling
  `lucide-react` with esbuild's WebAssembly build, in one thread); the first vanilla app installed for
  39 s. Later apps with the same stack reuse all of it.
- **A warm Next.js app** (with Tailwind) spends ~3 s starting next dev (native: 1.4 s) and ~4 s in its
  first compile (server 1.2 s, client 2.6 s), then ~1.5 s rendering.
