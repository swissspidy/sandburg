# ADR 0030: The host's share of a run

- Status: Accepted
- Date: 2026-10-23

## Context

ADRs 0025–0027 made the runtime's own hot path and cold starts faster. This round looked at the
host: the Node.js process that installs packages, transforms node_modules files, compiles what the
runtime sends it and serves it all, and that also drives Chromium through Playwright. A CPU profile of
the host (`node --cpu-prof`, one run in a fresh process) of a cold `fixtures/vite-react-counter` run
showed the main thread idle ~70% of the time (2.6 s busy in 9.2 s), and a cold
`fixtures/next-app-router` run 75% (10 s busy in 40 s). The host's cores were not the limit. What the
browser waited for was:

- **Playwright's routing.** The egress gateway routed every request of a run's context
  (`context.route('**/*')`): Chromium paused each one, the sandbox's own included, for a round trip
  through the host's main thread, and Playwright turns off the browser's HTTP cache while a route is
  set. A warm Vite run makes ~110 requests to its origin (the runtime's synchronous file requests,
  its worker scripts), a cold next dev run ~560.
- **A short prefetch.** The prefetcher kept 3 transforms in progress, so that the runtime's threads
  had the other cores; esbuild does a transform in its own process.
- **A compile cache in memory only.** A second `sandburg run` of an app, a new process, compiled
  everything its runtime sent again (next dev's chunks): 1.0-1.6 s more than a warm run in one
  process.
- **One long transform at the head of the prefetch.** A cold Vite run's first preload bundle waits
  for the prefetcher (ADR 0026), which finds a file's requires only once it is transformed. Vite 8's
  1.4 MB node chunk took 519 ms, 342 ms of it acorn parsing the chunk to rename the CommonJS names
  it declares (`const __dirname = …`), while the rest of the chain waited.

## Decision

- **The gateway intercepts HTTPS only** (`src/orchestrator/egress.ts`): it enables the Chrome DevTools
  Protocol's Fetch domain itself, on each page and out-of-process frame, for `https://*`, and answers
  as before (allowlisted origins from the cache or upstream, CORS preflights allowed, others blocked
  and recorded; CORS headers added to answers without them, as Playwright adds them). The sandbox
  origin is plain HTTP and is never paused. Plain HTTP to anything else
  goes to the context's egress proxy, which refuses and records it. For that to hold:
  - only the host server's port on `*.sandburg.localhost` bypasses the proxy (it was every port);
  - the host server refuses requests whose `Sec-Fetch-Site` is `same-site` or `cross-site`, so one
    sandbox cannot load another's files (they are all `*.sandburg.localhost`).
  The reference runtime (a Docker app on a port of its own) keeps routing every request.
- **No acorn pass for ES modules' CommonJS names** (`src/adapters/node/esm-names.ts`). esbuild's
  CommonJS output already renames a module's own `require` and `module` where it uses them; the
  runtime's wrapper of a converted ES module names its file and directory parameters
  `__sandburg_filename` and `__sandburg_dirname` (Node's ESM has neither), and esbuild's define sends
  `import.meta.filename`/`dirname` and free `__filename`/`__dirname` there. Output that still
  declares one of the wrapper's names (a top-level `let exports`, which esbuild keeps) fails V8's
  parse of the wrapper (`new Function`, never called: ~30 ms for Vite's node chunk) and is converted
  again after the old rename. `TRANSFORM_VERSION` 14.
- **The prefetch transforms 8 files at a time.**
- **Host compiles are kept on disk** (`.sandburg/compiled/v<TRANSFORM_VERSION>`,
  `src/adapters/node/compile-store.ts`), by the same key as in memory, the digest of what the host
  compiled; the digest route finds them too. Beyond 1 GB the oldest go when a process starts.

## Consequences

- The branch against main on an idle 4-core machine (`scripts/bench.ts`, interleaved, medians of
  3), cold: vite-react-counter 10.74 s → 7.67 s, lit-vite 7.24 → 6.18 s, next-app-router 28.02 →
  26.59 s; warm: 2.96 → 2.88 s, 2.27 → 2.26 s, 5.54 → 5.62 s. Part of the cold vite-react-counter
  gain is the harness: npm's install took ~5.7 s when it was the round's first cold install (npm
  revalidates registry documents older than 5 minutes), and base came first in two rounds of three.
  The time after the install phase, which this work changed: 4.60 → 4.14 s, 3.69 → 3.05 s, 19.15 →
  18.41 s. Each change's own A/B is in its commit message (the egress commit's cold
  vite-react-counter figure has the same artifact: after the install phase, 4.47 → 4.21 s).
- Converting every ES module of an install, one after another: 1.30 → 0.95 s (Next.js), 1.34 →
  0.71 s (Vite + React), 1.02 → 0.70 s (the Next.js seed app); none of their 903 files needs the
  fallback rename.
- **A sandbox's requests to `*.sandburg.localhost` on another port go to the egress proxy** and are
  blocked: before, they bypassed it, and reached any loopback service when routing did not see them
  (the escape test now tries one; main fails it).
- **A sandbox's plain-HTTP requests elsewhere are blocked by the proxy** (a 403, recorded as
  "plain HTTP through the egress proxy is not allowed") instead of by routing (`ERR_BLOCKED_BY_CLIENT`,
  "origin not allowlisted"). HTTPS is recorded as before.
- **Requests from another site to a sandbox's origin get a 403**, such as an allowlisted origin's
  iframe loading from the sandbox.
- **A popup or out-of-process frame's first requests may reach HTTPS before its interception is
  set**: those go through the proxy's tunnel to allowlisted origins (policed, not cached).
- **A second run of an app in a new process** (a second CLI run) does not compile again:
  next-app-router 6.5-7.4 s → 5.9-6.6 s, as warm as one process (5.4-5.6 s). `.sandburg/compiled`
  holds up to 1 GB.
- A 12-app batch from the corpus in 3 tabs (whole CLI process, 3 interleaved rounds): 30.7 s →
  30.0 s median.
- `network.requests` counts the context's requests (Playwright's request events), not routed ones.
- The browser's HTTP cache is on within a run's context.
- **A converted ES module's wrapper names its file and directory `__sandburg_filename` and
  `__sandburg_dirname`**: code that reads `__filename` or `__dirname` without declaring them still
  gets them (the define), but not through `eval` or `new Function`, where Node's ESM has none either.

## What did not pay

- **Transforms on worker_threads** (a pool of 1-3 workers, each with its own esbuild process, warmed
  while npm installs): cold vite-react-counter's start phase 2.06-2.19 s → 2.19-2.57 s in every
  configuration, host CPU +0.4-1.0 s (each worker loads the transform's modules and JITs them anew,
  and spawns an esbuild). The main thread was not the bottleneck; the transforms' latency was.
- **The runtime's 2.8 MB bundle cacheable within a run** (with the HTTP cache on, its workers load it
  from the cache): lit-vite's warm ready phase 0.28 → 0.55 s (4 of 4 rounds), others unchanged.
- **esbuild's asynchronous transform for the host's compile endpoint**, so that the host serves
  other requests during a compile: next-app-router cold 25.38 → 25.34 s, warm 5.43 → 5.46 s.
- **Playwright's routing with a pattern that excludes the sandbox origin** (a regular expression,
  matched in Playwright's server): Playwright still enables the Fetch domain for every URL and
  pauses every request; warm vite-react-counter 2.95 s → 3.14 s (n=3, medians: no gain).
- **npm's `--prefer-offline`** for the install: next's npm install 6.1/7.0 s → 7.2/7.6 s; npm is
  bound by extracting tarballs, not the registry.
- Cheaper regular expressions for the source patches: 1-3 ms per 1.4 MB file.
