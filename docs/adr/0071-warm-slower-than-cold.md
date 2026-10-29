# ADR 0071: Warm runs slower than cold in fidelity study v7: the method, not the runs

- Status: Accepted
- Date: 2026-10-28

## Context

Fidelity study v7 (`docs/fidelity/v7-node-vs-truth.md`) reported higher warm than cold medians for
six stacks. Median `totalMs` of the passing apps, cold → warm: Vue (Vite) 2.3 → 6.0 s, static HTML
1.2 → 2.4 s, Express + SQLite 4.7 → 6.5 s, Angular 7.5 → 10.7 s, Astro 6.7 → 9.5 s, SvelteKit
8.5 → 9.4 s. In Vue, Angular, Astro and Express about half the apps were more than 1.2× slower warm.
Vite + React (10.3 → 4.1 s) and Svelte (9.4 → 4.8 s) got faster. A warm run should never be slower.

v7's data has each run's status and total time only: no phases, no start times, so it cannot tell
which phase grew or what ran beside each app. v7 ran both passes with `sandburg batch` at 0403c34,
3 at a time, one after the other, with the default batch directory (`.sandburg/batches`).

## Measurements on main (ac9baea)

All measurements here, and v7.1's, were made at ac9baea, before [#113](https://github.com/swissspidy/sandburg/pull/113)'s guard against the rolldown
trap (ADR 0070).

4-vCPU, 16 GB Linux machine, Node.js 24.22.2, Chromium for Playwright 1.64.1 with its OS sandbox on
(as a non-root user). 32 corpus apps: 4 each of Vue, static HTML, Angular, Astro, SvelteKit, Vite +
React and Svelte, and 2 each of Express + SQLite with a Vue and with a React client. In each of 5
rounds, a cold batch (`.sandburg/` removed; npm's download cache warm) then a warm batch (same
stores), each in a process of its own, both in the same order (`longestFirst: false`), at
parallel 1 and at parallel 3. Median over the passing runs, cold → warm:

| Stack | Parallel 1 | Parallel 3 | Phase that drops most (parallel 1) |
|---|---|---|---|
| Vue (Vite) | 4.36 → 2.96 s | 8.89 → 6.36 s | start 1.38 → 0.94 s |
| Static HTML | 1.79 → 1.89 s | 4.06 → 4.57 s | none: no install, no dev server |
| Express + SQLite (Vue) | 7.28 → 4.10 s | 13.58 → 7.89 s | install 1.20 → 0.41 s |
| Express + SQLite (React) | 6.68 → 4.12 s | 15.63 → 8.31 s | install 1.72 → 0.50 s |
| Angular | 10.41 → 7.33 s | 24.98 → 13.43 s | ready 2.43 → 0.58 s |
| Astro | 8.44 → 6.62 s | 14.84 → 12.51 s | ready 4.31 → 2.75 s |
| SvelteKit | 11.13 → 5.84 s | 22.05 → 11.32 s | start 5.99 → 1.75 s |
| Vite + React (control) | 14.09 → 3.89 s | 25.08 → 9.09 s | ready 7.91 → 0.89 s |
| Svelte (control) | 7.06 → 3.04 s | 13.51 → 6.18 s | start 4.41 → 1.01 s |
| Batch wall time | 274 → 106 s | 177 → 69 s | |

Warm is faster on every stack that installs, at both parallelisms. The one phase that grows warm is
install on Svelte, SvelteKit and Astro (+0.15–0.45 s at parallel 1): their warm runs start from
the app's own dev-server cache (`.sandburg/dev-cache`, up to 12 MB here), which comes with the
install. The host's digests of it, computed on a project's first warm run, cost 30–50 ms for the
largest (12 MB); the rest is its transfer. Their start and ready drop by several times as much.
Static HTML, run alone (4 apps, 8 interleaved rounds, parallel 1): 1.39 → 1.40 s. Its one steady
gap is the batch's first app (110: 2.04 → 2.26 s), which in a cold batch runs after the stack
warm-ups and in a warm batch is the session's first tab.

At parallel 3 only one app of 32 was more than 1.2× slower warm (183-vue-vite, 6.3 → 7.7 s); at
parallel 1, none.

## Why v7 showed it

1. **The warm pass ran in another order.** A batch starts first the apps that took longest in the
   latest batches' summaries (`longestFirst`, ADR 0039). v7's cold pass had no history and ran in
   corpus order. Its warm pass read the cold pass's summaries (same `.sandburg/batches`) and
   started the 240 s timeouts and the apps that wait in failing checks first, and the passing apps
   of the fast stacks (Vue, static, Express, Astro, Angular) last, beside each other. Reproduced on
   main: on the same warm stores, two `sandburg batch corpus --parallel 3` runs, the first in corpus
   order and the second longest-first from the first's summary. Median of the passing apps,
   corpus order → longest first: Vue 2.1 → 4.4 s, static 0.9 → 2.4 s, Express + SQLite
   2.8 → 5.7 s, Angular 5.9 → 7.9 s, Astro 4.8 → 8.2 s, SvelteKit 4.3 → 7.4 s, Next.js 8.0 → 7.9 s;
   wall time 565 → 559 s. That is v7's pattern, with no cold pass in it.
2. **At parallel 3, an app's time is mostly what runs beside it.** The same app takes 2–3× as long
   at parallel 3 as alone (static 1.8 → 4.1 s, Angular 10.4 → 25.0 s cold, in the 32-app set). In
   corpus order a fast app runs beside apps that wait in a failing assertion or an install; last in
   a longest-first batch, it runs beside other passing apps, each busy in its own checks. The number
   of open neighbours is alike (static 5.0 and 4.6); the time goes to the checks phase (static
   0.45 → 1.70 s, Vue 0.58 → 1.69 s), and to ready and start. The stacks with long cold installs or
   starts (Vite + React 10.3 → 4.1 s, Svelte) gained enough from the warm stores to show a drop
   anyway.
3. **"Cold" was mostly warm.** Only a stack's first app installs from scratch: the other apps of
   the stack install from the store it filled, and Vite, Vite + React and Next.js are warmed up
   before the batch starts. v7's cold Angular median (7.5 s) is that of apps installing from the
   store. npm's own download cache was warm too, as v7 says.
4. Both passes ran the same code (0403c34): not a cause. Machine noise: across 5 rounds the batch
   wall time varied by 8% (parallel 3, cold) and 10% (parallel 3, warm), far less than v7's gaps.
5. No warm-only step costs more than it saves: the app's own dev-server cache adds 0.15–0.45 s to
   install and saves more in start and ready (above); store hits and the host scripts' code cache
   show as drops.

A first attempt at the study script ran every pass in one process: round 2's cold pass, after
`.sandburg/` was removed, then asked the host for files of installs the process still knew from
round 1 (ENOENT on `.sandburg/installs/<key>/node_modules/next/package.json`). A study pass, like
`sandburg batch`, runs in a process of its own; a library user who removes the stores under a
running process meets the same, which is not a supported use.

## Decision

- `scripts/fidelity-study.ts` runs a study's cold and warm passes: the corpus's order in both
  (`longestFirst: false`), each pass in a process of its own with its batch summaries apart,
  optionally several interleaved cold/warm rounds (each app's median), and each run's phases,
  start, end, open neighbours and the machine's CPU use while it ran in the JSON. Each pass is kept
  on disk as it ends, so a study cut off goes on from there.
- `sandburg batch --no-longest-first` does the same for the CLI (`longestFirst: false`).
- docs/fidelity/README.md says how to run and read the passes: compare per app at parallel 1 or
  where the CPU use is alike; at parallel 3 the batch's wall time is the measure.
- v7's corpus is run again this way, as v7.1 (docs/fidelity/v7.1-node-vs-truth.md).

## Consequences

- v8's cold and warm tables compare like with like: the same apps beside the same neighbours,
  with phases to show where a difference comes from.
- Per-app medians at parallel 3 still depend on what runs beside each app: a cold and a warm pass
  in the same order still differ in it (a cold pass's apps install), so the study's tables carry
  the CPU use beside the medians. In v7.1 (docs/fidelity/v7.1-node-vs-truth.md) warm is faster
  than cold on all 14 stacks, and no passing app is more than 1.2× slower warm (0 of 139).
- `longestFirst` stays the batch's default: it moves time between apps, not wall time (above), and
  ADR 0039's gain is for the batches whose last app would otherwise keep the cores idle.
- Angular, at parallel 3, failed in `ready` in 4 of 40 runs (3 cold, 1 warm) of the measurements
  above, and v7.1 recorded it in 2 of 24 cold runs (156 and 134): the intermittent rolldown trap,
  which [#113](https://github.com/swissspidy/sandburg/pull/113) fixes (ADR 0070), after these measurements. It is not a cold/warm effect.
