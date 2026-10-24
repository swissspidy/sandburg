# ADR NNNN: Next.js runs: a seed per router, a shorter start, a shorter Session.close

- Status: Accepted
- Date: 2026-10-24

## Context

After ADRs 0025-0033, a warm `fixtures/next-app-router` run took ~5 s on an idle 4-core machine
(install 0.5 s, start 1.3 s, ready 2.5 s, checks 0.6 s) and a cold one ~20-22 s, plus ~5-7 s in
`Session.close`, which waits for the Next.js seed run (ADRs 0016, 0026). Next.js' own trace
(`.next/dev/trace`) and CPU profiles of every browser thread (`scripts/profile.ts`) of warm runs:

- **Ready** is next dev's first compile and render on the runtime's one busy thread:
  `ensure-page` 1.6 s (the server compiler 0.9 s, then the client's 0.6 s, from the seed's webpack
  cache: inflating its 27 MB of packs, ~0.29 s, restoring and checking ~800 cached modules, building
  the app's own five), then the render, 0.4 s.
- **A Pages Router app found nothing of its own in the seed.** In a warm run of a Pages Router app,
  the client compiler still built ~200 of Next.js' modules (`next/dist/client/*`, react-dom, the dev
  overlay; 2.5 s) and the server ~100. webpack names a module by the index of the loader rule that
  compiled it (`…??ruleSet[1].rules[9].oneOf[13].use[2]!…`), and Next.js configures more rules for a
  project with an app directory: the App Router seed's modules have other names. A third of the
  Next.js apps `scripts/corpus` generates use the Pages Router.
- **Start** waited for a child process: next dev reads tsconfig.json with `tsc --showConfig` (Next.js
  16 with TypeScript 7), and the runtime's thread idled ~0.3 s from the spawn to the child's exit.
  Sandburg's tsc shim answers in ~10 ms; the child then ended as every process here does, once its
  event loop had stayed idle for 0.2 s.
- **Session.close after a cold run** waited for the seed run to upload webpack's cache: the page
  posted 36 MB of JSON to the host as a string, which reached the host 4.4 s after `fetch` was
  called, and the answer came back 2.4 s after the host had written it (one trace). The page also
  polled the cache once a second until two reads matched.

## Decision

- **A seed per router** (`nextRouter`, `nextSeedProject` in `src/adapters/node/index.ts`): an app
  without `app/` (or `src/app/`) starts from a seed of the Pages Router (a page with `next/head`,
  `next/link` and a stateful component, another page, an API route under `pages/api`), run once per
  set of versions as the App Router's is. Its key adds the router; the App Router's key and seed
  project are unchanged.
- **The tsc shim exits once `--showConfig` has printed** (`process.exit(0)`, as tsc ends when it is
  done). The shim is written into installs: `LAYOUT_VERSION` is bumped, so installs are made again
  (from the package store).
- **The seed's upload**: the cache goes to the host as a Blob, and the page polls for webpack's
  store every 250 ms; a tree with one of webpack's temporary files (`<name>_`, renamed when written)
  is not taken for stable.
- **A fixture**, `fixtures/next-pages-router`: the habit tracker of `next-app-router` on the Pages
  Router (a custom `_app` and `_document`, an API route under `pages/api`), same versions and checks.

## Consequences

- Against origin/main with the fixture (`scripts/bench.ts --base 3af4bc7`, which is origin/main and
  `fixtures/next-pages-router` only; interleaved, medians, all runs passed; warm 4 rounds, cold 3):

  | Fixture | Mode | Total | Start | Ready | `Session.close` |
  |---|---|---|---|---|---|
  | next-pages-router | warm | 5.49 -> 3.57 s (-35%) | 1.31 -> 1.23 s | 3.22 -> 1.34 s | |
  | next-app-router | warm | 5.30 -> 5.43 s (+2%) | 1.32 -> 1.20 s | 2.65 -> 2.65 s | |
  | next-pages-router | cold | 15.57 -> 16.45 s (+6%) | 6.64 -> 6.58 s | 3.84 -> 4.19 s | 8.14 -> 1.34 s (-83%) |
  | next-app-router | cold | 20.96 -> 21.51 s (+3%) | 6.70 -> 6.59 s | 8.10 -> 8.12 s | 4.53 -> 3.29 s (-27%) |

  The App Router's warm median has one first round in which the branch's checkout held no App
  Router seed (a cold run before had left only the Pages Router's, so that run's first run started
  the seed beside it): 8.49 s; rounds 2-4, 5.19 -> 5.09 s. Cold totals move with npm's install
  (±1 s between rounds); the cold Pages Router app now has its own, smaller seed run beside it,
  where it had the App Router's.
- A cold run and its `Session.close` (what a one-off CLI run waits for; sums of the medians): App Router
  25.5 -> 24.8 s, Pages Router 23.7 -> 17.8 s.
- Each change's own A/B is in its commit message: Pages Router seed, warm `next-pages-router`
  5.74 -> 3.78 s (ready 3.41 -> 1.33 s, n=4); tsc shim, start 1.26 -> 1.07 s (`next-app-router`) and
  1.40 -> 1.27 s (`next-pages-router`, n=4); the seed's upload, `Session.close` after a run with no
  seed stored 5.7-6.8 -> 3.0-3.3 s (n=4 each) and 5.04 -> 4.03 s in a cold bench (n=3).
- **Behavior changes**: a Pages Router app's first run on a set of versions starts a seed run of
  its own beside it (as the first App Router app does), and `Session.close` waits for it; the seed
  projects' files are Sandburg's. Each router has its own seed: the first app of the other router
  on a machine runs without one, as the first app of a set of versions does. A program that runs TypeScript 7's `tsc --showConfig` sees it exit
  as soon as it has printed. Installs made before this are made again once. The page uploads a
  dev-server cache (every framework's) as a Blob.
- **Security**: no new route, socket or cache key a run controls. The Pages Router seed is
  Sandburg's own project; its key is a digest of the versions the install resolved and the router,
  which only chooses between Sandburg's two seed projects. As before, a seed's key takes one write,
  the seed run's own (`pendingSeeds`), and a run can store a cache only under a key it was issued and
  only files under that key's directories (`writeDevCache`). An e2e test has an app's page post a
  cache under each seed's key (which it learns from its bundle URL): the host answers 403 and the
  seeds are unchanged. The upload is the same request with a Blob body; the poll runs in the page.

## What did not help

Measured with interleaved warm runs (`scripts/bench.ts`, 4-5 rounds) unless noted.

- **Inflating webpack's packs ahead.** next dev inflates the seed's packs on the runtime's thread
  (server 105 ms, client 182 ms). On another thread as the runtime starts, with the gunzip stream
  matching its input against the bundle's files in full: start +0.12 s, ready -0.12 s, total -2%
  (n=5). On that thread once the program listens: the helper's inflate of the server pack took
  461 ms, ready +0.3 s. On the runtime's own thread once it listens: the first request comes ~50 ms
  later and waits for the inflate (ready 2.5-2.96 s against ~2.5 s).
- **Uncompressed packs** (`compression: false`): a 140 MB seed; ready 2.19-2.54 s against ~2.5 s,
  but the install phase +0.35 s for the bigger bundle (and 113 MB more per run, 5x the disk). The
  page's read of the cache skips files of 64 MB or more (resource limits), so the client compiler's
  78 MB pack would not even be stored.
- **SWC on worker threads**: a pool of 2 threads (each its own instance of SWC's WebAssembly build,
  `transformSync`) that takes next-swc-loader's transforms once 16 have been asked for. A run with no
  seed: ready 5.58 s against 5.58 s (median of 4). The runtime's thread spent 0.43 s in SWC instead of
  2.0 s, but the threads spent 3.1 s (fresh instances, cold code), each fetched SWC's 30 MB build,
  and the runtime's other work grew: on this 4-core machine, work moved to other threads of the
  renderer slowed the runtime's thread (as the inflating above did).
- **The seed run's timing.** A seed run beside a cold app costs the app ~3 s (to the result, 22.5
  and 21.4 s against 18.1 and 18.9 s without a seed run; start 6.6-6.9 s against 4.8-5.0 s). Starting
  the seed when the app reaches its checks: 19.1 and 19.0 s to the result, but `Session.close`
  12.2 and 12.6 s (the seed run alone takes ~12 s); when the app reaches ready: no clear change.
- **The seed's routes.** A seed stores only its first page's compile: webpack stores its cache 5 s
  after a compile the first time and 60 s after later ones, so the seed's route handler and second
  page, compiled in its checks, are never stored. Having the seed run store its cache as it ends
  (`cache.shutdown`, from a patch of Next.js' hot reloader) with requests instead of clicks: the seed
  had them, but `Session.close` went 3.0-3.3 -> 6.4-7.3 s (a full store, gzip on the runtime's
  thread), and the fixture's checks were no faster (0.6-0.65 s; its route compiles while the checks
  wait for the page). Storing after every compile (`idleTimeout: 0`): `Session.close` 10-11 s (each
  store wrote the 21 MB client pack again).
- **A Pages Router page in the App Router's seed**: Pages Router apps' ready 3.75 -> 3.51 s only
  (the rule indices differ), and the seed's checks +3 s.

## Not done

- The seed's checks could be cut to what is stored (its first page): the route and second page
  compiles cost the seed run ~3 s that no app gains from (above). Left as is: the stored cache's
  timing overlaps them.
- TypeScript 5 and 6 apps: next dev runs TypeScript's own `tsc --showConfig` in a child process,
  which loads the 9 MB compiler (~0.3 s of start). Answering it in JavaScript, as the TypeScript 7
  shim does, would replace TypeScript's config parsing with an approximation for those versions.
- A child process waits 0.2 s of idle loop before it ends (`exitWhenIdle`, for work the runtime
  cannot see); every program that waits for a child pays it.
- Tailwind CSS v4 (most generated apps) adds ~1.2 s to a Next.js app's ready in this runtime: its
  oxide scanner runs ~1.5 s of WebAssembly on its own threads while the compile waits.
