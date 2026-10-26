# ADR NNNN: Known bugs (round 5): a dev script's page port, requests no app made, late allocators

- Status: Accepted
- Date: 2026-10-26

## Context

Earlier rounds noticed four bugs and left them open. Each was reproduced first; each fix has a test
that fails without it.

1. **A page without a `Content-Type` under a compound dev script waited 60 s** (ADR 0043's "Not
   done"; ADR 0044 fixed the case of a whole HTML document only). For a dev script the runtime's
   shell runs, the host takes the port that answers `GET /` with HTML (`pagePort`), as an API server
   may listen before the page's dev server and `ng serve` listens only once it has compiled. A server
   that answers without a `Content-Type` and with a body that is no document (`<h1>Hello</h1>`, plain
   text) answered no HTML, and `pagePort` waited 60 s without a new port before it took the first:
   `node prep.js && node server.js` started in **61.3 s** on origin/main. The wait existed because
   the host could not tell whether another server was still coming.
2. **The network check failed on requests the app did not make.** On origin/main, one warm
   `next-app-router` run reported 11 blocked requests: 6 `CONNECT https://www.google.com`, 4 `CONNECT
   https://content-autofill.googleapis.com` and `POST https://registry.npmjs.org/-/npm/v1/security/
   advisories/bulk`. A context whose page requests nothing (`data:text/html`) sent 4 CONNECTs to
   www.google.com:443 through its proxy. A Chromium net log names the CONNECTs: the browser context's
   own network context preconnects to the default search engine as a profile starts
   (`PreconnectToSearch`), and asks the autofill server about forms (`AutofillServerCommunication`,
   ADR 0031). The POST is not npm (the host's npm runs with `--no-audit`): it is Next.js 16.4's dev
   server, which checks its own version against npm's advisories as it starts
   (`experimental.agentUpgrade`, `'security'` by default; `lib/upgrade/prepare-upgrade.js`, from
   `server/lib/router-server.js`).
3. **Late allocators and the memory reserve** (the CodeRabbit finding on #55; ADRs 0039 and 0046).
   ADR 0046 had already replaced 0039's 10 s window with "the expected peak less what the renderer
   uses now, until its checks". Two late allocators were still not covered: an app that passes its
   expected peak before its checks (no history and a renderer past 1 GiB, or a project larger than
   last time) counted as done growing, and an app that allocates in its checks (a route Next.js
   compiles when the checks first visit it) counted as nothing.
4. **Seed runs in the guard** (ADR 0046's "Not done"): a cold Next.js run's seed run has its own
   renderer, up to 1.4 GB, which the guard did not count.

## Decision

- **The runtime reports how many of the program's processes are still starting**
  (`node-runtime/process-tree.ts`). A process is starting while it runs, serves no HTTP port of its
  own and waits on no child process; a shell script with commands still to start (`node api.js &
  sleep 3 && node page.js` while it sleeps) counts too. Each runtime reports its count to its parent
  (`starting` messages): its own (a worker thread is no process and counts 0) plus what each nested
  runtime reported last; a child process counts as starting until it reports, and one that ended no
  more. The program's runtime reports the whole tree's count to the page. Once it has been 0 for 1 s
  with no new port, `pagePort` takes the first port (still preferring the one that answers HTML). The
  60 s rule holds where a process is left starting (`concurrently "node api.js" "ng serve"` while ng
  compiles). A server on a port the system picked (a tool's probe) does not count as up.
- **Chromium's own network features are turned off**: `PreconnectToSearch` and
  `AutofillServerCommunication`. Chromium takes only the last `--disable-features` switch, so a
  second one would have replaced Playwright's (turning `AimEnabled` back on, whose `/async/folae`
  requests then reached the proxy too; this is why ADR 0031 left the autofill traffic).
  `launch.ts` reads Playwright's list from playwright-core (which does not export it), leaves
  Playwright's switch out (`ignoreDefaultArgs`) and passes one with both lists. If the list cannot be
  read, Playwright's switch stays as it was; a unit test fails if a Playwright version builds it
  otherwise.
- **Next.js' advisories check is off by default**: a source patch sets `experimental.agentUpgrade`'s
  default to `false` in `next/dist/server/config-shared.js`, as `experimental: { agentUpgrade: false
  }` in next.config would. An app that sets the option itself still gets the check (and the POST is
  refused as before). `TRANSFORM_VERSION` 24 → 25.
- **The memory guard follows each app's measured peak** (`outstanding` in `batch.ts`; the renderer's
  peak so far is `RunRenderer.peak()`): an app that passes its expected peak before its checks is
  expected to reach 1.5 times the most it used (`OUTGROWN_MARGIN`); in its checks, an app whose
  project has an earlier peak holds that peak less the most this run used (its peak, not what it
  uses now, so a collection still frees memory for the next app); with no earlier run, nothing, as
  before.
- **A seed run is another open app for the guard** until it ends (`RunOptions.onSeed`: the seed
  run's phases and renderer go to the callbacks it returns), expected to reach 1 GiB.

## Consequences

| Fix | Measured | Before | After |
|---|---|---|---|
| Page port | `node prep.js && node server.js`, `<h1>Hello</h1>` without a Content-Type | start 61.3 s | whole run 1.8 s |
| Requests no app made | warm `next-app-router`: blocked requests | 11 | 0 |
| Late allocators | 24 corpus apps, warm, `parallel` 4, 4.5 GB cgroup (n=3): wall | 33.45 s | 33.47 s (+0%) |
| | the same: peak renderers | 2,405 MB | 2,367 MB |
| Seed runs | SEED_MEASUREMENT | | |

- Without a memory limit the guard does not bind and nothing changes; in the cgroup the warm batch
  ran as fast (16/24 passing on both sides), as its apps stay within their history's peaks.
- **Behaviour changes**: a dev script whose servers answer no HTML is taken once all its processes
  serve a port (1-2 s), not after 60 s; the runtime posts `starting` messages to the page; Chromium
  runs with `PreconnectToSearch` and `AutofillServerCommunication` off; Next.js dev servers do not
  query npm's advisories unless the app's config asks for it; a batch may open its next app later
  while an app grows past its expected peak, an app with an earlier peak allocates in its checks, or
  a seed run is open; `RunRenderer.peak()` and `RunOptions.onSeed` (API).

## Security

- **Egress**: no rule changed. The requests that no longer reach the proxy are turned off at their
  source (a browser feature, a framework default); had they been sent, the proxy and the gateway
  would refuse them as before (a browser test shows none reaches a run's proxy, and, as its control,
  that Playwright's switches alone send them). The network check counts everything it counted.
- **The disabled features** only remove network activity of the browser's own; the features
  Playwright disables stay disabled (a unit test checks the merged switch).
- **`starting` messages** go from the runtime to its own page, as the `listening` messages do: the
  app can lie about them, as it can about its ports, and at most makes its own run take a port
  sooner or later. Nothing crosses to the host or another run.
- **The source patch** changes a default in Next.js' own code, applied by the transform as the other
  patches are, keyed by content digest and `TRANSFORM_VERSION`.
- **The memory guard** reads only what it read before (renderers' memory from `/proc`, summaries'
  peaks, capped); its changes can only delay the next app.

## What did not help

- `--disable-field-trial-config`, `--disable-preconnect` and `--dns-prefetch-disable` left the
  preconnects to www.google.com as they were (4 per context).
- A second `--disable-features` beside Playwright's: Chromium kept only the last one.

## Not done

- The memory guard's margins (`OUTGROWN_MARGIN` 1.5, a seed's 1 GiB) come from the renderers
  measured in ADR 0046, not from a batch that exceeds them.
