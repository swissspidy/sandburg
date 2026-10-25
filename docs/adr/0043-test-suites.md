# ADR 0043: The test suites: speed, reliability and the security model's tests

- Status: Accepted
- Date: 2026-10-25

## Context

Rounds one and two (ADRs 0028-0039) made runs faster and added tests with each change. This round
looked at the suites themselves: how long they take locally and in CI, whether they are reliable, and
whether each boundary of the security model (ADRs 0001, 0005, 0030 and the boundaries later ADRs
added: the file channel, the package store, the dev-server caches) has a test that tries to break it.

What the suites took (all passing):

| Suite | Local, cold (empty `.sandburg`, fixtures not in `~/.npm`) | Local, warm (median of 5) | CI on main (run 40136346513, test step) |
|---|---:|---:|---:|
| e2e/node | 151 s | 108 s (3 runs); 46 s after this ADR | 107 s |
| e2e/vite-frameworks | 154 s | 44.7 s (3 runs) | 100 s |
| e2e/angular | 102 s | 35.0 s (3 runs) | 62 s |
| e2e/browser-install | 74 s | | 34 s |
| e2e/frameworks | 58 s | 38.7 s | 56 s |
| e2e/fullstack | 55 s | 27.9 s | 41 s |
| e2e/run | 46 s | 33.4 s | 55 s |
| e2e/batch | 26 s | 22.7 s | 25 s |
| e2e/websockets | 20 s | 11.9 s | 35 s |
| e2e/page-checks | 9 s | 7.8 s | not run |
| unit (25 files, in parallel) | 10.9 s | | ~10 s |

CI runs each e2e file as a job of its own, so a CI run takes as long as its slowest job: ~3 minutes
when nothing goes wrong. What went wrong, and what the suites lacked:

- **page-checks never ran in CI.** Its suite (ADR 0023, checks that run in the page) was added in #22
  without a matrix entry.
- **apt.** Every Chromium job ran `playwright install --with-deps`: 21-47 s, and in one job of that
  run 7 min 20 s, apt fetching fonts at 62 kB/s from a slow mirror (the whole run took 9 minutes
  instead of 3). Every library Chromium needs was on the runner image already ("is already the newest
  version"); apt only added fonts (CJK, unifont, freefont) and upgraded libglib, libnss3 and xvfb.
- **A suite could hang instead of failing.** In the batch suite, a test that started a server (the
  canary, the host server, the egress proxy) and then failed to launch Chromium left the server
  open; `node --test` waits for the file's process to exit and shows its results only then, so a
  missing or broken Chromium hung the job, with no output, until its 45-minute timeout.
- **No time was recorded per suite or test**, so a suite that got slower showed only when it hit the
  timeout.
- **Most of the node suite was one test waiting out a 60 s timeout.** "TypeScript 7 type-checks a
  project in the runtime" took 62 s in every run, warm or cold (start phase 61.9-62.2 s): its dev script
  is `tsc --noEmit -p . && node server.js`, and its server answered without a content-type. For a dev
  script the runtime's shell runs, the host looks for the port that answers `GET /` with HTML
  (`pagePort`) and, finding none, waits 60 s without a new port before it takes the first.
- **The unit suite's critical path was one test waiting out a 5 s timeout** in real time
  (thread-vfs: "a thread whose parent is blocked answers from its snapshot after all").
- **The host server's checks had no test of their own.** The e2e test of another sandbox's script
  shows a refusal, not which check refused; the file channel's origin check was tested on a bare
  server, not as the host server routes an upgrade; `/__sandburg/nm` and the dev-cache routes were
  tested only along their happy paths.

## Decision

- **page-checks runs in CI**, as a job of its own.
- **Each test job reports its times** (`scripts/test-times.ts`, a `node:test` reporter beside
  `spec`): each file's time and the 10 slowest tests in the job summary, and a warning annotation for
  a file over its budget (`test/budgets.json`, about twice its time in CI). A warning, not a failure:
  hosted runners are noisy (the perf job does the same with its table).
- **CI installs Chromium without apt**, tries to launch it, and runs `playwright install-deps` only if
  it does not start (runtime, pack and e2e jobs).
- **The batch suite opens everything inside the `try` that closes it**: a browser that does not
  launch fails its tests in 1.2 s instead of hanging the file.
- **The TypeScript 7 test's server sends `content-type: text/html`**, as dev servers do: 62.5 s →
  2.4 s; what it checks is unchanged.
- **The blocked-parent wait is an argument** of `RemoteVfs`/`ThreadVfs` (`PARENT_BLOCKED_MS`, 5 s,
  unless given; the runtime gives none); the unit test gives 1 s.
- **The control run of the dead-proxy test waits until the canary is reached** (at most 5 s) instead
  of 1.5 s; the runs that must show that nothing is reached still wait their fixed 1.5 s.
- **New attacker-case tests** (see the table below): `test/unit/host-server.test.ts` (forged Host,
  `Sec-Fetch-Site`, unregistered sandboxes, sandbox ids, the file channel's upgrade through the host
  server), `test/unit/node-routes.test.ts` (`/__sandburg/nm` traversal and links, dev caches under
  keys the host did not issue, the filter of what a run posts as its cache), a test in
  `test/unit/package-store.test.ts` (an install rule's shim over a file linked from the store), and
  more cases in `test/unit/egress-proxy.test.ts` (plain HTTP to an allowlisted host, CONNECT to its
  other ports, loopback names and a sandbox's own name). Each new check was seen to fail with the
  check it covers removed (the proxy cases aside, which extend a test of the same check).

### The security model and its tests

| Boundary | Enforced in | Tested by (attacker case) |
|---|---|---|
| One sandbox per origin; a request names its sandbox by Host, on the host server's port only | `host-server.ts` `sandboxOf`, `register` | `unit/host-server`: other port, unknown id, bare domain, loopback names, unregistered sandbox, ids with dots |
| Requests from another site (another sandbox) refused | `host-server.ts` (`Sec-Fetch-Site`) | `unit/host-server` (GET/POST to the host page, its script, dev-cache, compile, the service worker); `e2e/batch` (a script of another sandbox does not load) |
| File channel only for the sandbox's own pages; frame and body limits | `host-socket.ts` | `unit/host-server` (another sandbox's Origin, another site's, none, own name on another port, unknown sandbox, other path); `unit/host-socket` (frame over `MAX_FRAME`, bodies over `MAX_BODY`, other paths) |
| Installed files only from an install's `node_modules` | `install.ts` `raw`/`file` (digest key, no `..`, `node_modules/` prefix, the install's index: no links) | `unit/node-routes` (`..` plain and encoded, the install's own files, a symlink out, keys that are not digests) |
| Dev caches stored only under keys the host issued, within their directories; read only when handed to a run | `adapters/node/index.ts` `writeDevCache`, `cacheEntries`, `cacheBundle` | `unit/node-routes` (unissued key: 403, nothing written; a cache on disk not handed to the run: not read; `..`, absolute paths, sibling directories and other shapes dropped from what a run posts); `e2e/node` (a seed's key after the seed was stored: 403). |
| Nothing leaves the browser but through the gateway (dead proxy; only the host server's port bypasses it) | `session.ts` `launchOptions`, context proxy | `e2e/batch` (canary on loopback by three names, another port of `*.sandburg.localhost`, every kind of request; the backstop alone; a control without it) |
| HTTPS: allowlisted origins only, GET/HEAD only upstream, in pages and workers | `egress.ts` | `unit/egress` (matcher), `e2e/batch` (page, worker, nested worker, POST from a worker), `e2e/run` |
| Plain HTTP refused; no tunnels for intercepted contexts; tunnels only to allowlisted origins elsewhere | `egress-proxy.ts` | `unit/egress-proxy` (plain HTTP to any host incl. allowlisted, GET and POST; CONNECT to others, other ports, loopback names, a sandbox name; `noTunnels`); `e2e/batch` (a popup's first request). |
| npm runs with `--ignore-scripts`; tarballs match their integrity; tar entries and bin links stay in the package | `install.ts`, `package-store.ts`, `npm/tar.ts` | `unit/resolver`, `unit/package-store` (tampered tarball, bin links out), `unit/npm` (tar paths). |
| The store's hard-linked files are never written in place | `package-store.ts` `fixBin`, `install.ts` `replaceFile` | `unit/package-store` (`fixBin` makes a new inode; an install rule's shim over a linked file leaves the store's copy) |
| Request bodies bounded on the file channel | `host-socket.ts` | `unit/host-socket` |

Boundaries found untested or weaker than assumed while writing these tests were reported to the
maintainers and are fixed separately, each with its test.

## Consequences

- CI: page-checks runs; each job's summary has its times; Chromium jobs no longer run apt (save 15-40 s
  per job, and the minutes a slow mirror costs).
- The unit suite: 10.9 s → 7.0 s (median of 4, interleaved).
- e2e/node: 108 s → 46 s warm (the TypeScript 7 test: 62.5 s → 2.4 s); e2e/batch: 26-29 s → 22 s
  warm. Reliability: 30 warm runs of run, page-checks, batch, websockets, fullstack and frameworks
  (5 each), 9 of node, vite-frameworks and angular (3 each), 3 of the runtime suite, and one cold run
  of every e2e suite but reference (Docker): all passed; no flaky test was found.
- Runs are unchanged (the production code changes are an optional argument and two exports).
  `scripts/bench.ts --base origin/main --head HEAD`, interleaved, 3 rounds, medians of the time to the
  result: vite-react-counter warm 1.86 → 1.95 s, cold 6.65 → 6.82 s; lit-vite warm 1.43 → 1.40 s,
  cold 5.33 → 5.43 s (noise: phases move both ways).
- **Behaviour changes:** none for the package. `RemoteVfs` and `ThreadVfs` take an optional last
  argument. CI's Chromium has no extra fonts (no test compares rendered text).

## What did not help, or was left out

- **Caching npm's cache (`~/.npm`) across CI runs**, so that the e2e jobs' installs do not download:
  `actions/setup-node` with `cache: npm` already restores a 204 MB `~/.npm` in every job, saved by the
  first job to finish after the root lockfile changes, with whatever that job's fixtures fetched. A
  cache per suite would make each job's warm state its own, for a few seconds each.
- **Splitting the slowest suites across jobs.** `node --test --test-shard` splits by file, and node and
  vite-frameworks are one file each (107 s and 100 s in CI); splitting them by test name would save
  ~50 s of a ~3 minute run and make the matrix harder to keep right.
- **An app whose page has no content-type, started by a compound dev script, waits 60 s** (for the
  runtime's owners, not done here): `echo hi && node server.js` with `s.end('<h1>…</h1>')` starts in
  61.5 s, `node server.js` alone at once. Browsers sniff such a page as HTML; `pagePort` could too
  (a body that starts with `<`), or take a lone port sooner.
- **Shorter app-bug tests.** The slowest e2e tests besides installs are the app-bug cases (a TSX,
  Svelte or Vue syntax error, an undeclared import, SCSS without a preprocessor; ~10 s each): the
  ready phase gives an app that logged a console error 8 s (`CONSOLE_GRACE_MS`) to render anyway. A
  test-only switch would test something else than users get; a faster verdict for build errors
  (a 500 for the app's own module is strong evidence) belongs to the run's ready phase, not the tests.
