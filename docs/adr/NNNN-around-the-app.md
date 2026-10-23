# ADR NNNN: The fixed costs around the app

- Status: Accepted
- Date: 2026-10-23

## Context

A trace of a warm `fixtures/lit-vite` run (2.9 s; host and page timestamps) showed how much of a
short run went to work around the app rather than to the app's dev server:

- **Opening the tab**: the egress proxy, a browser context, the init script, a page, the egress
  routes, then the host page: ~160 ms before `mount`. The runtime worker was created only in the
  install phase, and fetched, compiled and evaluated the 2.8 MB runtime there (~190 ms).
- **The checks** (~400 ms): axe-core's 650 KB source went through `page.evaluate` into the app's
  frame in every run (110-250 ms, against ~55 ms for the scan), after the screenshot and the
  accessibility snapshot had each run on their own.
- **Ready**: after the app frame's load event, Playwright's `waitForFunction` first set itself up in
  the new frame (~30-50 ms) before it checked anything.
- **The install data**: a Vite app's own pre-bundled dependencies went to the page inside the
  install data (2.9 MB of JSON for `vite-react-counter`) through `page.evaluate`, then into the
  runtime's init message.
- **Batches** ran `parallel` apps until each had its result, so a slot sat idle while an app's
  checks waited on a failing assertion (in the corpus, up to the 15 s a check asked for).

## Decision

- **A spare tab** (`Session`, `Tab`): a session keeps the next run's tab ready: context, proxy,
  routes, init script, host page loaded, runtime worker evaluated. The first opens as the browser
  launches; each run that takes it opens the next beside it. A run's tab is still its own (a fresh
  context and origin, never reused); only when it was opened changes. `SessionOptions.spareTab:
  false` turns this off; seed runs and a visible browser do not open spares.
- **The host page starts the runtime worker as it loads** (`prepare()` in the adapter's browser
  module); the process takes it with its init message.
- **Checks**: the host server serves axe-core (`/__sandburg/axe.js`) and the page checks' runtime
  (`/__sandburg/page-checks.js`) on every sandbox origin. The checks import them (compiled off the
  main thread) while the screenshot and the accessibility snapshot are taken side by side; the scan
  still runs after them. A Content-Security-Policy on the app's document, or a failed import, falls
  back to `evaluate`.
- **Ready asks the host page first** (`HostApi.rendered`, the same condition read from the frame's
  same-origin document); `waitForFunction` and its reloads only when that says no.
- **A Vite app's own cache comes as a bundle** the runtime fetches (the route seeds use), and the
  page tells whether the run changed it by a digest computed the same way on both sides
  (`cache-digest.ts`).
- **Batches start the next app when one reaches its checks**: `parallel` apps start and run at a
  time; at most twice `parallel` are open. `RunOptions.onPhase` reports each phase as it starts.

## Consequences

- Warm runs on an idle 4-core machine, against the code before (full Chromium, medians). Each
  change's own interleaved A/B is in its commit message.

  | Fixture | scripts/bench.ts (4 rounds) | 4 rounds x 5 runs, same .sandburg state (n=20) |
  |---|---|---|
  | `node-express` | 0.94 s → 0.58 s | 976 → 578 ms (−41%) |
  | `lit-vite` | 2.73 s → 2.56 s | 2769 → 2315 ms (−16%) |
  | `vite-react-counter` | 3.63 s → 3.07 s | 3808 → 3359 ms (−12%) |

  Load goes to 0, install −65 to −75%, checks −16 to −19%; start is 7-50% longer, from the next
  run's tab opening beside it.
- A batch of 12 corpus apps (scripts/corpus seed 1: 4 vite-react, 4 Next.js, 4 vite-vanilla; 3
  tabs, warm, 3 rounds): 34.1 s → 29.9 s (−12%), with the same results; the batch scheduling alone
  32.8 s → 29.1 s.
- A one-off CLI run (`sandburg run fixtures/node-express`, browser launch included, n=5): 2.35 s →
  2.18 s.
- **A session holds one more browser context** while it is open (a spare, with its runtime
  evaluated: tens of MB), and opening it costs the phase it overlaps 30-80 ms.
- **The sandbox's id** (its origin's first label) is the tab's own (`s-…`), not the run id.
- **Check timings overlap**: the screenshot, accessibility snapshot and axe-core's loading run side by
  side, each timed on its own.
- **A run requests `/__sandburg/axe.js`** from the app's frame (counted in `network.requests`), and
  defines `window.axe` there as before.
- **A batch can have up to twice `parallel` apps open**, the extra ones in their checks.

## What did not help

- **Registering the service worker earlier** (in `mount`, at page load after the runtime worker, once
  the worker booted, or beside the program's start): node-express gained 20-40 ms, but Vite apps lost
  50-180 ms in start or ready. A worker created once the service worker controls the page is
  controlled too, and the first navigation through a just-activated service worker is slower; we
  did not find a placement that won for both.
- **Service worker static routing** (`InstallEvent.addRoutes`, sending `/__sandburg/*` to the network
  without the fetch handler): no gain, vite-react ready slower.
- **Closing a run's tab in the background**: the result came ~40 ms sooner, but the next run paid it
  (back-to-back runs and batches unchanged).
- **Opening the replacement spare later** (when the run starts waiting for render, or its checks):
  the overlapped phase pays the same 30-80 ms; at the checks it doubled the screenshot's time.
- **Heaviest apps first in a batch** (meta-frameworks, then Vite, then the rest): 12% slower. Three
  Next.js apps at once contend for the cores, and a light app with a long check became the tail.
- **Skipping the read-back of an untouched dev cache** (the runtime tracking writes since init):
  dispose 60 → 4 ms for vite-react, but totals did not show it in two rounds (+2%, noise in start and
  ready); left out.

## Not done

- **Request interception**: Playwright enables CDP `Fetch` interception for every URL once a route
  exists (and turns the HTTP cache off), so each of the runtime's synchronous requests to the host
  makes a round trip through Node. Without routes, warm Vite runs were ~5% faster (start −120 to
  −190 ms). Routes also keep one sandbox from reaching another's origin (`*.sandburg.localhost`
  bypasses the proxy), so narrowing them needs another guard first: for example a per-sandbox
  HttpOnly cookie the host server requires, then CDP `Fetch.enable` for `https://*` only (plain HTTP
  already goes to the egress proxy, which refuses and records it).
- **Chromium's autofill traffic** (`content-autofill.googleapis.com`, refused by the egress proxy and
  reported by the network check) could be turned off with `--disable-features=AutofillServerCommunication`,
  but Playwright passes its own `--disable-features`, which a second one would replace.
- Playwright's default headless shell (when `SANDBURG_CHROMIUM` is unset) ran warm runs ~10-15%
  faster than full Chromium in new headless mode here.
