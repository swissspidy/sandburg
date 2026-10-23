# ADR 0033: Faster meta-framework runs

- Status: Accepted
- Date: 2026-10-23

## Context

After ADRs 0025–0027, warm runs of the meta-framework fixtures took 9–15 s on an idle 4-core machine
(one run each, the second of a fresh session): Nuxt 14.2 s, SolidStart 13.5 s, Astro 13.2 s, Angular
12.6 s, SvelteKit 12.4 s, Next.js 11.7 s (before its seed was stored), React Router 9.1 s. Profiles
(`scripts/profile.ts`), the host's request log and per-thread CPU (`top -H`) showed that much of this
was not the frameworks' own work, and that the run was mostly serial: one runtime thread busy, the
others waiting.

- **Dev-server caches thrown away.** Only `node_modules/.vite/deps` was kept between runs. SvelteKit
  forced a re-optimization on every start (vite-plugin-svelte keeps `_svelte_metadata.json` beside
  `deps/`, and forces Vite to optimize again without it), `deps_ssr` (SvelteKit, Astro, SolidStart,
  React Router) was pre-bundled again, and Nuxt (`node_modules/.cache/vite`) and the Angular CLI
  (`.angular/cache/<version>/<project>/vite`) scanned and pre-bundled every run. The caches that were
  kept reached the runtime as base64 in the install data (~0.6 s for 5–8 MB).
- **Threads fetched what their parent had.** A worker thread or child process asked the host for its
  first 40 installed files one by one, then fetched the install's preload bundle (20–40 MB) again;
  a warm Angular run made 184 such requests and 4 bundle fetches. Dev servers start many threads:
  rolldown's and oxc's WebAssembly threads, Nitro's worker, the Angular CLI's workers. (A thread
  reading its parent's bundle from shared memory is ADR 0029's; not decided again here.)
- **One synchronous request per SSR module.** Vite's SSR module runner evaluates each module with
  `new AsyncFunction(body)`; the runtime has the host lower the body (for AsyncLocalStorage). The host
  answers from memory in ~0.4 ms, but each request took ~12 ms on the runtime's side, and Astro
  evaluates ~340 modules before its first page (SvelteKit and SolidStart 50–100).
- **Processes the server does not need.** `react-router dev` relaunches itself with
  `--conditions=development`; `nuxt dev` starts two processes ahead for restarts once it is ready;
  the Angular CLI compiles TypeScript in a worker thread; every napi-rs WebAssembly package (rolldown,
  oxc, Astro's compiler, satteri) starts a pool of 4 async workers on its first async call. Here each
  is a runtime that boots and loads its code again while the program waits (Astro's first page waited
  for three such pools).

## Decision

- **Dev-server caches**: a run keeps `node_modules/.vite`, `node_modules/.cache/vite` and
  `.angular/cache` (threads' project snapshots leave `.angular` out); a cache is complete once some
  `_metadata.json` is in it. An app's own cache comes to the runtime as a bundle
  (`/__sandburg/dev-cache/<key>/bundle`, as seeds do) with the SHA-256 of each file in the install
  data; the page stores the cache again only when a file differs.
- **Compile cache** (`src/adapters/node/compile-cache.ts`): the host records what it compiles for a
  run (POST `/__sandburg/compile`) under the run's dev-cache key (the project's files and its
  install), in `.sandburg/dev-cache/compiled-<compiler hash>-<key>.bin`, code under 256 KB (larger
  code is asked for by digest), up to 48 MB a project (older
  runs' entries out first; 8 projects in memory). The next run of the project fetches them as one
  bundle at its first compile and looks a compile up there by the whole code before asking the host.
  An entry is the host's own output for the code it was sent, so a run can add entries but not change
  what other code compiles to, and a run gets only its own project's.
- **Framework options**, in the browser runtime only (not in `DEV_ENV`, which the Docker reference
  shares): `NG_BUILD_PARALLEL_TS=0` for Angular apps; `react-router dev` starts with
  `--conditions=development` (the runtime takes node options, `execArgv`, for the program it starts);
  `nuxt dev` gets `--no-fork` unless the dev script sets `--fork` or `--no-fork`;
  `NAPI_RS_ASYNC_WORK_POOL_SIZE=1` for every program.

## Consequences

- Against origin/main on an idle 4-core machine (`scripts/bench.ts --base origin/main`, interleaved,
  3 rounds, medians of the time to the result; all 84 runs passed):

  | Fixture | Warm | Cold |
  |---|---|---|
  | react-router-app | 8.56 s → 5.26 s (−38%) | 21.79 s → 20.24 s (−7%) |
  | astro-app | 13.07 s → 8.40 s (−36%) | 38.56 s → 40.43 s (+5%) |
  | angular-tasks | 11.78 s → 7.85 s (−33%) | 35.93 s → 34.96 s (−3%) |
  | sveltekit-app | 11.70 s → 8.17 s (−30%) | 30.69 s → 30.52 s (−1%) |
  | nuxt-app | 14.24 s → 11.95 s (−16%) | 52.70 s → 52.84 s (+0%) |
  | solid-start-app | 12.91 s → 11.13 s (−14%) | 32.45 s → 29.23 s (−10%) |
  | next-app-router | 11.13 s → 11.75 s (+6%) | 35.51 s → 36.04 s (+1%) |

  Cold totals move with npm's install; their start and ready phases were unchanged or faster (React
  Router's start 8.62 → 6.71 s, SvelteKit's ready 4.91 → 4.25 s). Next.js' warm start was 0.7 s
  slower in that run (the compile cache then kept next dev's multi-MB chunks: a 27 MB bundle); code
  of 256 KB or more is no longer kept, and Next.js' warm start went 2.12 → 1.88 s against the
  version measured here. Each change's own A/B is in its commit message; the largest: Astro's
  compile cache 12.5 → 8.5 s, SvelteKit's cache directory 12.1 → 9.5 s, React Router's conditions
  6.8 → 5.3 s, Angular's TypeScript on its own thread 8.4 → 7.2 s.
- Cold runs gain little: the caches and compiles are a project's own, kept for its next run; a never
  run app still pre-bundles and compiles everything. Cold start and ready phases were unchanged or
  slightly faster in each change's A/B (cold totals vary by ±10 s with npm's install).
- **Behavior changes**: `process.execArgv` of a `react-router dev` program shows
  `--conditions=development`, the "[restart] Relaunching" line is gone and the program has no
  `REACT_ROUTER_DEV_RESTARTED`; `nuxt dev` restarts in its own process after a change to
  `nuxt.config`; the Angular CLI's TypeScript diagnostics come from its own thread;
  `process.env.NAPI_RS_ASYNC_WORK_POOL_SIZE` is `1`, so a napi-rs package runs its async work on one
  worker; a project's dev-server caches and compiles from its earlier run are kept in
  `.sandburg/dev-cache` (up to 48 MB of compiles a project) and used by its next run.
- **Tried, not kept** (interleaved, n=3):
  - V8 flags: `--no-lazy-feedback-allocation` (Nuxt 11.3 → 12.2 s, Astro 8.8 → 8.7 s),
    `--always-sparkplug` (11.3 → 11.8 s, 8.8 → 8.9 s).
  - The Service Worker Static Routing API for `/__sandburg/` (the runtime's synchronous requests took
    ~12 ms with or without it).
  - A route pattern that leaves the sandbox origin out of the egress gateway's `context.route`, so
    Playwright continues those requests without calling the handler: no measurable change (Astro 7.7
    → 8.1 s, Nuxt 11.4 → 11.2 s, Next.js 7.2 → 8.0 s, Vite + React 3.7 → 3.6 s). Chromium still pauses
    every request for interception. Without any route, 300 synchronous compiles took 3.1 s instead of
    4.7 s, and a first Astro run 11.4 s instead of 14.0 s: the gateway's caching and policy could move
    to the egress proxy (which already polices what routing cannot see), so that no request to the
    sandbox origin is intercepted.
