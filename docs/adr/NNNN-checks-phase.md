# ADR NNNN: The checks phase, and what comes after it

- Status: Accepted
- Date: 2026-10-24

## Context

After ADR 0031 the checks of a warm run still took 0.5-0.6 s for Astro and Vite apps and 1.5-2.9 s
for SvelteKit, SolidStart and Nuxt. Per-check timings of warm runs (full Chromium, an idle 4-core
machine) showed where it went:

- **Clicks before hydration.** The meta-frameworks' "hydrates and is interactive" checks click the
  server-rendered button inside `toPass` and expect its count to change within 1 s. A click before
  the client code has hydrated the page does nothing, so each lost click waited out the 1 s first:
  SvelteKit lost one round (1.2 s for the check), Nuxt two (2.5 s). Both went on loading client
  modules after the checks began: SvelteKit for ~0.4 s, Nuxt for ~1.6 s.
- **Playwright's polling.** A web-first assertion polls at 0, 0, 20, 70, 170, 270 ms, then every
  500 ms. SolidStart's "a form posts to a server action" waits ~1 s for the dev server's answer, and
  saw it at 1.4 or 1.9 s depending on the poll it fell before.
- **Dispose** read a restored dev-server cache back from the runtime, hashed it and compared it with
  the digests it started from, in every run: 8 MB and ~180 ms for SvelteKit, ~60 ms for Vite React,
  for a cache that had not changed.

The screenshot (~50 ms of capture and encoding when idle), the accessibility snapshot (~20 ms) and
axe-core's scan (~55-70 ms) are small on an idle machine; in a batch they take 0.3-0.9 s each, waiting
for CPU with the other apps' dev servers.

## Decision

- **The functional checks start once the app can take input** (`HostApi.settled`, `host/settle.ts`).
  Beside the screenshot, the accessibility snapshot and axe-core, the checks wait, at most 3 s, until:
  - the framework says so, where it does: Solid's server-rendered page records events until it has
    hydrated and replays them (`_$HY`), and React replays a click once its root exists (Next.js and
    React Router hydrate the document): no wait; Nuxt says when it has hydrated (`isHydrating`);
  - else the app's servers are quiet: no request from the page for 100 ms, and none in flight sent
    within the last second (an event stream or a long poll stays open). The runtime's process
    reports when the page last sent a request and the age of the youngest one in flight.
- **An assertion that waits is checked more often** (`settlingExpect`): a web-first assertion on a
  locator or page (`toBe*`, `toHave*`, `toContain*`, `toMatchAriaSnapshot`; not `toHaveScreenshot`,
  which writes files, nor `toPass`, which runs a callback) that has not passed after 250 ms is also
  checked once every 100 ms beside it (the same matcher with a 1 ms timeout), and passes when such a
  check does. A failure, and its message, are the assertion's own.
- **Dispose reads a restored cache back only if the run changed it.** The runtime notes, from the
  program's start, whether a file under the restored cache's directories changes (`Vfs.track`:
  written with other bytes, added, removed or renamed; written again with the same bytes is no
  change). Unchanged, nothing is read or stored; changed, it is read, compared and stored as before.

## Consequences

- Warm runs, `scripts/bench.ts`, origin/main vs this branch (both as refs), 3 rounds, medians, on an
  idle 4-core machine with full Chromium. Each commit's own interleaved A/B is in its message.

  | Fixture | checks | dispose | total |
  |---|---|---|---|
  | `sveltekit-app` | 1.60 → 0.91 s (−43%) | 0.19 → 0.01 s | 7.14 → 6.26 s (−12%) |
  | `nuxt-app` | 2.93 → 2.21 s (−24%) | 0.01 → 0.01 s | 12.33 → 11.51 s (−7%) |
  | `solid-start-app` | 2.50 → 2.12 s (−15%) | 0.02 → 0.01 s | 10.16 → 10.02 s (−1%) |
  | `astro-app` | 0.61 → 0.68 s | 0.04 → 0.02 s | 8.21 → 8.11 s |
  | `vite-react-counter` | 0.43 → 0.52 s | 0.06 → 0.01 s | 3.05 → 3.38 s |

  The head side's `.sandburg/` was new in that run (its first round filled the host's caches). Again
  with both sides warm, 6 rounds: `vite-react-counter` checks 0.54 → 0.47 s, total 3.42 → 3.13 s;
  `astro-app` checks 0.59 → 0.62 s, total 7.84 → 8.13 s. Astro's checks moved between −17% and +10%
  across four A/Bs (~0.6 s, nothing in them waits): no change we can tell from noise.
- A batch of 12 corpus apps (scripts/corpus seed 1: 4 vite-react, 3 Next.js app router, 1 pages
  router, 4 vite-vanilla; 3 tabs, warm, 3 rounds each side, interleaved): 37.4 → 35.4 s (medians;
  runs ranged 34.8-38.0 s on both sides: within noise). Every app's status, and every check's status
  and message, were the same in all six runs. The batch's time goes to apps whose checks wait (one
  app's failing assertion with its own 15 s timeout) and to the artifacts waiting for CPU.
- **A functional check may see the app a little later than before**: up to 3 s for an app that keeps
  loading, typically 0.1-1.6 s for a server-rendered app that hydrates, and no later for one whose
  framework says input is safe. A check that looked for a state the app showed only in its first
  moments (a loading message replaced within ~100 ms) could now miss it. The artifacts (screenshot,
  accessibility snapshot) and axe-core's scan are taken as before, on the app as it first rendered.
- **An assertion that waits passes up to ~400 ms sooner**, and costs one extra check of the page
  every 100 ms while it waits. Failures take as long as before, with the same messages.
- `HostApi.activity()` reports `sinceRequestMs` and `newestInflightMs` besides `inflight` and `idleMs`.

## Security

- `settled` runs in the host page and reads the app frame's window (the same origin, ADR 0004) and
  the runtime's own counters. A value the app controls (`_$HY`, `__reactContainer$…`, Nuxt's
  `isHydrating`) can only make the checks start sooner or later, within the 3 s bound; a getter that
  throws reads as "no word from the framework". Nothing the app sends is evaluated on the host.
- The extra checks of an assertion are Playwright matchers on the sandbox's own frame, the same as
  the assertion's own polls; a callback (`toPass`) is never run more often than Playwright runs it.
- The dispose change only skips a read and a POST to `/__sandburg/dev-cache/<key>` that the host
  would have accepted or refused as before; what the host stores, and the checks on it (keys issued
  to the run, directories, sizes), are unchanged.
- Tests: `test/runtime/settle.test.ts` (each framework's signal, an app getter that throws),
  `test/runtime/settling-expect.test.ts` (sooner passes, the same failure message and time, `toPass`
  callbacks not run again), `test/unit/vfs-track.test.ts` (what counts as a change).

## What did not help

- **Waiting for quiet servers everywhere**: SolidStart's checks went 1.9 → 3.5-4 s (its dev overlay
  loads modules for 2 s after the page hydrated, and Solid replays early clicks anyway), Next.js
  paid 350-410 ms. Hence the frameworks' own signals.
- **Nuxt's `__vue_app__`** as its signal: Nuxt mounts its app before its page component has hydrated,
  and clicks were still lost; `isHydrating` is the one that matches.
- **Solid's `_$HY.done`**: set on the first event handled after hydration, not when it hydrates.
- **The screenshot through CDP** (`Page.captureScreenshot` with `optimizeForSpeed`, carets hidden and
  fonts awaited as Playwright does): ~31 ms against Playwright's ~50 ms for a 1280x800 PNG when the
  page is idle, but no gain in runs (70-190 ms either way): the first capture waits for a frame from a
  renderer busy with axe-core's import and the accessibility snapshot.
- **axe-core's scan beside the accessibility snapshot** (after the screenshot; axe-core neither
  scrolls nor moves focus unless asked to): checks +2 to +9% on vite-react-counter, lit-vite,
  node-express and astro-app (4 rounds); all three run on the renderer's main thread anyway.
- **Closing the tab** takes 35-70 ms (`context.close()`; the egress proxy ~0). ADR 0031 found that
  closing it in the background moves the cost to the next run; not tried again.

## Not done

- **More frameworks' signals**: Angular's event replay (`withEventReplay()`, hydration annotations
  `ngh`) and Astro's islands (an `astro-island` loses its `ssr` attribute once hydrated) could say when
  input is safe; their checks did not wait on hydration in the fixtures (0.5-0.6 s).
- **Checks in the page** (`--checks-in page`) poll at most every 250 ms (`POLL_MS`); the same
  100 ms checks could apply there.
- **In a batch the artifacts wait for CPU**: the screenshot, accessibility snapshot and axe-core's
  scan took 0.3-0.9 s each with three apps' dev servers running, against ~0.15 s idle. axe-core's
  650 KB script is compiled anew in every run (each run is its own browser context, with its own
  code cache); a way to share V8's code cache across contexts would save that.
