# Fidelity study v8: the v7 stacks at their current releases

Run 2026-11-21 at 2db0c7e (main at 160c204 with
[#144](https://github.com/swissspidy/sandburg/pull/144)'s SvelteKit fix merged in), on a 4-vCPU,
15 GB Linux container with Node.js 24.22.3, Chromium for Playwright 1.65.0 **with its OS sandbox
off** (the container runs as root, where the sandbox cannot start: `SANDBURG_NO_BROWSER_SANDBOX=1`),
3 tabs at a time. The method is v7.1's (`scripts/fidelity-study.ts`, 2 rounds of a cold pass then
a warm pass, both in corpus order; docs/fidelity/README.md, "Cold and warm passes"). Data:
[`v8-node-vs-truth.json`](v8-node-vs-truth.json) (cold) and
[`v8-node-vs-truth-warm.json`](v8-node-vs-truth-warm.json) (warm).

## The corpus

Apps 000–099 (Vite, Vite + React, Next.js 15) are v1–v7's, unchanged. Apps 100–231 are v7's apps,
regenerated (`node scripts/corpus/generate.ts corpus 232 1`, seed 1: the same stacks, features
and faults) with the frameworks that `scripts/corpus/stacks.ts` pins exactly moved to their
current releases:

| Package | v7 / v7.1 | v8 |
|---|---|---|
| @sveltejs/kit | 3.1.0 | 3.4.0 |
| @sveltejs/adapter-auto | ^8.0.0 | ^9.0.0 |
| svelte | 5.57.3 | 5.59.1 |
| @angular/* (CLI, build) | 22.2.3 (22.2.4) | 22.3.0 |
| nuxt | 4.6.3 | 4.6.4 |
| astro | 7.4.2 | 7.4.13 |
| @solidjs/start (solid-js) | 2.1.0 (1.9.17) | 2.2.3 (1.9.20) |
| react-router | 8.5.1 | 8.5.2 |
| vue | 3.5.44 | 3.5.46 |

Packages given as ranges (Vite, the Vite plugins, Express, …) resolve to their newest matching
release at install time, in v7.1 as here. Solid stays on 1.x: SolidStart 2.2.3, the latest, requires
solid-js ^1.9.15.

## Against ground truth

Cold: **232/232 right**. Warm: **232/232**. Every seeded fault was caught in both passes (93/93),
and no run of either round was wrong (0 of 464 cold, 0 of 464 warm).

| Framework | Apps | Right, cold / warm | False alarms, cold / warm | Faults caught, cold / warm | Median, cold → warm | Slower warm (>1.2×) | CPU while it ran, cold / warm |
|---|---|---|---|---|---|---|---|
| vite-react | 34 | 34 / 34 | 0 / 0 | 8/8 / 8/8 | 6.6 s → 2.0 s | 0 of 26 | 95% / 95% |
| nextjs | 33 | 33 / 33 | 0 / 0 | 10/10 / 10/10 | 8.0 s → 6.5 s | 0 of 23 | 95% / 91% |
| vite-vanilla | 33 | 33 / 33 | 0 / 0 | 9/9 / 9/9 | 1.9 s → 1.4 s | 0 of 24 | 97% / 93% |
| sveltekit | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 8.7 s → 5.0 s | 0 of 6 | 81% / 73% |
| angular | 12 | 12 / 12 | 0 / 0 | 7/7 / 7/7 | 7.8 s → 5.7 s | 0 of 5 | 83% / 82% |
| nuxt | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 10.8 s → 9.1 s | 0 of 6 | 87% / 90% |
| astro | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 7.1 s → 5.6 s | 0 of 6 | 74% / 73% |
| solid-start | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 9.0 s → 5.0 s | 0 of 6 | 81% / 83% |
| react-router | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 5.1 s → 3.1 s | 0 of 6 | 81% / 71% |
| vue | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 2.3 s → 2.0 s | 0 of 6 | 88% / 83% |
| svelte | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 6.4 s → 2.6 s | 0 of 6 | 88% / 83% |
| lit | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 2.2 s → 1.7 s | 0 of 6 | 88% / 72% |
| express-sqlite | 12 | 12 / 12 | 0 / 0 | 6/6 / 6/6 | 4.0 s → 2.7 s | 0 of 6 | 75% / 63% |
| static | 12 | 12 / 12 | 0 / 0 | 5/5 / 5/5 | 1.1 s → 0.5 s | 0 of 7 | 85% / 70% |
| **All** | 232 | 232 / 232 | 0 / 0 | 93/93 / 93/93 | 5.9 s → 2.6 s | 0 of 139 | 92% / 90% |

Wall time, cold / warm: 738.6 s / 550.1 s (parallel 3, 2 rounds, 232 apps).
Wrong runs over all rounds, cold / warm: 0 / 0 of 464.
Runs more than 1.2× slower warm than the same round's cold run: 183-vue-vite in round 2 (1.7 s → 2.1 s), 229-lit-vite in round 2 (1.8 s → 2.5 s).

- **Angular's rolldown trap is gone.** v7.1's one false alarm (an intermittent WebAssembly trap,
  156 and 134 cold) did not come back in either round: this is the first study since
  [#113](https://github.com/swissspidy/sandburg/pull/113) guarded shared WebAssembly memory growth
  ([ADR 0070](../adr/0070-wasm-memory-growth-race.md)).
- **No app is slower warm** by its medians (0 of 139, as in v7.1); two single runs were, in round 2.

## What the new releases broke: SvelteKit's first click

A first run of this study, at fb60ff2 (the corpus change alone, without #144), got SvelteKit wrong
3 times cold and 4 times warm, out of 12 (122, 133 and 199 cold; 122, 133, 155 and 199 warm), in
both rounds alike: correct apps failed a functional check as `app-bug`. Each was a first click
lost. The counter check clicks Increment twice and read "Count: 1".

Svelte 5.59 runs `init_operations()` as soon as its client runtime loads
(`svelte/internal/init-operations`, which the compiler now imports into every component). That sets
`__svelte_meta = null` on `Element.prototype` before anything hydrates. Sandburg judged a SvelteKit
page hydrated by `'__svelte_meta' in element` (`inputSafe`, src/host/settle.ts), true on every
element from then on, so the checks started on server-rendered buttons whose handlers were not
attached yet. 5.59 also no longer gives the elements it hydrates an own `__svelte_meta`, so an
own-property test alone would never say hydrated. #144 waits instead for what Svelte attaches as
it hydrates, in 5.57 and 5.59 alike: an element's delegated handlers (`Symbol('events')`) or a
binding (`Symbol('form reset')`). With it, the 12 SvelteKit apps are 12/12 in both passes, at
8.7 s cold and 5.0 s warm (v7.1: 8.5 s and 4.6 s). Whether a first click is lost depends on when
the checks start against when the page's last modules run, which is why only some of the 12 apps
showed it.

## Time

| | v7.1 | v8 |
|---|---|---|
| Wall time, cold | 784 s (808 s, 760 s) | **739 s** (round 1: 751 s, round 2: 726 s) |
| Wall time, warm | 568 s (566 s, 569 s) | **550 s** (551 s, 549 s) |
| Run time summed over runs, cold / warm | 3,240 s and 3,121 s / 2,480 s and 2,486 s | 2,971 s and 2,889 s / 2,342 s and 2,342 s (rounds 1 and 2) |
| Runs that hit the 240 s deadline, cold / warm | 2 / 2 in each round | 2 / 2 in each round (148, 203: SolidStart faults, as in v7.1) |
| Median of the apps passing in both passes, cold → warm | 6.7 s → 3.4 s | 5.9 s → 2.6 s |

The times are not a like-for-like comparison with v7.1: the machine differs (a container here),
and Chromium ran without its OS sandbox, which v7.1 had on. The answers do not depend on either.

## Reproduce

```sh
node scripts/corpus/generate.ts corpus 232 1
node scripts/fidelity-study.ts corpus --parallel 3 --rounds 2 --out docs/fidelity/v8-node-vs-truth
```
