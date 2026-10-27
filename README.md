# Sandburg

[![CI](https://github.com/swissspidy/sandburg/actions/workflows/ci.yml/badge.svg)](https://github.com/swissspidy/sandburg/actions/workflows/ci.yml)

Run and test generated web apps inside the browser.

Sandburg takes a web project, starts it with its own dev server on a Node.js runtime that runs in a
browser tab, and checks it end to end with Playwright in the same tab. It needs no container or VM
per run: one browser runs many sandboxes side by side, each on its own origin.

**[Try the demos →](https://swissspidy.github.io/sandburg/)** Next.js, Vite + React, SvelteKit, Angular and a
Vue + Express + SQLite app, running in your browser.

**[Generate an app →](https://swissspidy.github.io/sandburg/generate/)** Describe an app. Claude or Gemini, with
your own API key, writes it with React, Vue, Angular, SvelteKit, SolidStart, Next.js, Nuxt, Astro or plain
HTML, CSS and JavaScript, with a backend and SQLite. Your tab then installs it from npm and
runs it on its own dev server. Later requests change the running app, and errors go back to the model to fix
([ADR 0021](docs/adr/0021-generate-in-the-browser.md)).

## At a glance

- **The project's own tools.** `next dev`, Vite 5–8 with its plugins, `ng serve`, `nuxt dev`, `astro dev`,
  Express, and a dev script as written (`concurrently "vite" "node server"`). There is no reimplementation of a framework's build.
- **Correct answers.** Tested on 100 generated apps with known faults (study v6), it gets 97 right, with no false
  alarms. The three misses are mislabelled apps. `sandburg compare` measures agreement with a Docker
  reference.
- **Fast after the first run.** Installs, compiled modules, and dev-server caches carry over between
  runs and between projects that share packages.
- **Contained.** A sandbox reaches the network only through a caching gateway and a per-sandbox
  allowlist, and tests prove it.

| 100-app study ([v6](docs/fidelity/v6-node-vs-truth.md), 2026-09-30, 4 vCPU, 3 tabs at a time) | Median run, cold | Median run, warm |
|---|---|---|
| Vite, vanilla (33 apps) | 3.4 s | 3.2 s |
| Vite + React (34) | 16.1 s | 5.9 s |
| Next.js 15 (33) | 14.4 s | 13.0 s |
| All 100 | 13.2 s | 6.5 s |
| Whole corpus, 3 tabs | 533 s | 289 s |

A run includes the install, the dev server's start, the first render and the checks. "Cold" starts
from empty Sandburg caches (npm's own cache warm). The study predates the speed work in ADRs
0017–0059. The fixtures on 2026-10-26, at 8dda85e: a one-off run of `node scripts/bench.ts` on a
4-core, 15 GB Linux machine, 3 rounds ([command, setup and every run](docs/bench/2026-10-26.md)):

| Fixture | Cold run | Warm run |
|---|---|---|
| vite-react-counter (Vite 8, React 19) | 5.2–5.5 s | 1.2–1.3 s |
| lit-vite (Vite 8, Lit) | 4.4 s | 1.0 s |
| next-app-router (Next.js 16) | 19.1–19.3 s | 3.9 s |

Each cell is a median of three runs. The script measures two sides, here both 8dda85e, so a range
gives the two sides' medians: the spread between runs of the same code. A warm run is a session's
second run of the project. Each ADR records its own before-and-after measurements.

## Quick start

Requires Node.js 24 (LTS) or later.

```sh
npm install --save-dev sandburg
npx sandburg run ./my-app --checks checks.spec.ts
```

Sandburg drives Chromium with the Playwright it installs. If that Playwright's Chromium is missing,
the run stops and prints the command that installs it (`npx playwright@<version> install chromium`; on
Linux, add `--with-deps` for its system libraries). `SANDBURG_CHROMIUM=/path/to/chrome` uses another
Chromium instead.

From a checkout, Sandburg runs its TypeScript sources directly:

```sh
npm install
npx playwright install chromium
node bin/sandburg.js run fixtures/vite-react-counter --checks fixtures/vite-react-counter/checks.spec.ts   # or: npm run spike
```

## CLI

```sh
sandburg run <project> [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                     # each subdirectory, .zip or .json in <dir> is a project
sandburg compare <dir> --reference docker [--report path]
sandburg snapshot <project>                             # store it, print its snapshot id
sandburg open <project>                                 # load it in a visible tab
```

- `<project>` is a directory, a `.zip` (a single top-level folder is stripped), a JSON file tree
  (`{ "path": "contents" }`), or `snapshot:<id>`. Every run stores its project as a
  content-addressed snapshot, so any run can be reopened exactly.
- `--offline` answers every request from the HTTP cache (`.sandburg/cache`) and fails on a miss.
- `--install-in browser` (opt-in) has the page install the packages from the npm registry and
  compile modules itself: the host only serves static files ([ADR 0018](docs/adr/0018-browser-install.md),
  [ADR 0020](docs/adr/0020-compile-in-the-page.md)).
- `batch` and `compare` run one tab per core, up to 8, by default. In `batch` and `compare`, a
  project's own `checks.spec.ts` (or `app.checks.spec.ts` next to `app.zip`) takes precedence over
  `--checks`. Directories whose name starts with `.`, and archives or JSON files whose name starts
  with `.` or `_`, are skipped.
- Exit codes: `0` passed, `1` a blocking check failed, `2` the run did not reach the checks or they
  did not finish in time, `64` a usage error.
- `--no-browser-sandbox` runs Chromium without its OS sandbox, for hosts where it cannot start
  (see [Security](#security)).
- `--save-files <regex>` (run, with a project directory) writes the app's files whose path matches
  `<regex>`, as they are after the checks (its SQLite database, say), back into the project. The
  pattern decides what is written: anchor it, e.g. `--save-files '\.db$'`.
- `sandburg --help` lists the other options (`--ready`, `--save-files`, `--headed`, `--json`, `--out`, …).

Every run also has built-in checks, without a checks file ([`src/orchestrator/checks.ts`](src/orchestrator/checks.ts)).
A page that is a server error, or an uncaught error in the app, fails the run. Failed or blocked
requests are reported without failing it. A screenshot, the accessibility tree and an axe-core scan
are recorded, not enforced.

A checks file default-exports named checks. Each gets the app's frame, Playwright's `expect`, and
`appUrl(path)`:

```ts
import type { Checks } from 'sandburg';

export default {
  'counter increments on click': async ({ app, expect }) => {
    await app.getByRole('button', { name: /count is/ }).click();
    await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1');
  },
  'about page': async ({ app, expect, appUrl }) => {
    await app.goto(appUrl('/about'));
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('About');
  },
} satisfies Checks;
```

Each check has a time limit (30 s; `timeouts.check` in the library's `RunOptions`), and all of them
together have the checks phase's (180 s; `timeouts.checks`). A check that runs out of time is
stopped, not left running beside the next one: the Playwright call it is waiting in fails, any call
it makes after that fails (after a moment, so a loop that ignores the error does not stall the run),
its `expect(…).toPass()` stops retrying, and the route handlers and event listeners it added to
`page` are removed (not those it added to `page.context()`, nor `routeWebSocket()` handlers). The app is then loaded again at the
URL it first loaded at; its result (failed) says so. Loading it again resets only what lives in the
page: cookies, `localStorage`, IndexedDB, service workers, the context's routes, the viewport and a
fake clock carry over to the next check. A check also gets `signal`, an `AbortSignal` that aborts
when it is stopped: pass it to waits of its own (a timer, a `fetch`), which Sandburg cannot stop.
With `--checks-in page`, waits and actions stop the same way, but code of a check that catches the
error and goes on cannot be stopped. When the checks phase runs out of time, the checks that
finished and the artifacts already taken are kept: the check that was running fails, and those that
had not started are reported as skipped (`not run`); the run's status is `error`.

A checks file is imported by Sandburg's Node process: it can do anything a program on this machine
can. For checks someone else wrote (a coding agent), `--checks-in page` runs the file's code in the
sandbox tab instead, with the same `app`, `expect` and `appUrl`: Playwright's locators (resolved
by [ivya](https://github.com/vitest-dev/ivya)), actions and assertions, waiting as Playwright's do.
The file cannot import anything, and input comes from scripted events, so CSS `:hover` does not
apply and a native `<select>`'s list does not open ([ADR 0023](docs/adr/0023-checks-in-the-page.md)).

## Library

```ts
import { Session, dockerReference } from 'sandburg';

const session = new Session();
await session.open();
const result = await session.run('./project', { checks: './checks.spec.ts' });
const reference = await session.run('./project', { nodeRuntime: dockerReference(), checks: './checks.spec.ts' });
await session.close();
```

Each run writes `result.json` ([schema](src/result-schema.json)), `screenshot.png` and `a11y.yaml`
to `.sandburg/runs/<runId>/`. Every failure has a class (`app-bug`, `runtime-unsupported`, `timeout`,
`infra`, `unknown`) and names the rule that decided it ([`src/classify.ts`](src/classify.ts)). App bugs
point at the file and line where the dev server reported them.

## What runs

| | |
|---|---|
| Front ends | Vite 5–8 with its plugins (React, Vue, Svelte, Solid, Preact, Lit, Tailwind), SvelteKit 2, Astro 7, Nuxt 4, React Router 8, SolidStart 2; `next dev` (Next.js 15–16, App and Pages Router, webpack, SWC); `ng serve` (Angular 22); static sites. Each framework is one entry of the table in [`src/framework.ts`](src/framework.ts), which also sets the order detection tries them in |
| Back ends | Express and other Node servers next to the front end, reached through Vite's proxy, from the page (`http://localhost:<port>`) or over WebSockets; SQLite (`better-sqlite3`, `sqlite3`, `node:sqlite`) |
| Dev scripts | `&&`, `\|\|`, `;`, `&`, `cd`, `VAR=value`, `cross-env`, npm/pnpm/yarn scripts, package binaries, `concurrently`; `tsx`, `ts-node` and `nodemon` run their file directly |
| Node APIs | `fs`, `http`, `worker_threads`, `child_process` (Node programs), `node:wasi`, `AsyncLocalStorage` across native `await`s ([ADR 0057](docs/adr/0057-native-awaits-and-the-runtime-warm-path.md)), top-level await, WebSockets. Native tools run on their WebAssembly builds: SWC, rolldown, rollup, esbuild, lightningcss, Tailwind's oxide; TypeScript 7's `tsc` runs tsrs ([ADR 0024](docs/adr/0024-typescript-7.md)) |
| Not supported | Native addons without a WebAssembly build, synchronous child processes, programs other than Node (`git`, `python` exit with 127), dependencies that are not npm registry versions (git, URL, `file:`, `link:`, `workspace:`, `user/repo` shorthands: the install fails) |

## How it works

1. **The host** (the orchestrator, in Node.js) installs the project's packages with npm
   (`--ignore-scripts`) and serves them to the browser. It also compiles modules for the runtime and
   keeps the caches. With `--install-in browser`, the page installs and compiles instead.
2. **The runtime** is Node.js 24 in a Web Worker: a virtual file system, a CommonJS/ESM loader, and
   Node's built-in modules. It runs the project's dev script. Child processes and worker threads are
   more runtimes.
3. **A service worker** gives the app its origin: the page's requests go to the servers listening
   in the runtime, with streaming and WebSockets.
4. **Playwright** runs the checks in the app's frame, and collects screenshots, accessibility trees,
   console errors and network failures.

The map of the code (where each module runs, what may import what, the contracts between the parts,
where to add a framework) is [`docs/architecture.md`](docs/architecture.md), kept true by
`test/unit/architecture.test.ts`. The design decisions are recorded in [`docs/adr`](docs/adr). [ADR 0006](docs/adr/0006-node-runtime.md)
covers the runtime, and [ADR 0014](docs/adr/0014-node-runtime-only.md) covers the single runtime and the
cold-start work. [ADR 0001](docs/adr/0001-runtime-adapters-serving-results.md) gives each sandbox its own origin and
routes every request through the egress gateway (allowlist, cache);
[ADR 0005](docs/adr/0005-wordpress-playground.md) (named for an adapter since removed) adds a per-sandbox egress proxy
for what the gateway cannot intercept; [ADR 0054](docs/adr/0054-security-review-round-4.md) maps every boundary an app
can reach and how the host holds it.

## Security

An app runs in a tab of its own: its own browser context and origin, every request through the
egress gateway and the sandbox's egress proxy (the allowlist). Under that, Chromium runs inside its
OS sandbox (on Linux: namespaces and a seccomp-bpf filter for each renderer), and with
`--site-per-process` a frame of another site gets a renderer process of its own
([ADR 0061](docs/adr/0061-chromium-sandbox.md)).

The sandbox needs a host that allows it. On Linux it needs unprivileged user namespaces, which
Chromium does not use as root, and which Ubuntu 23.10 and later restrict with AppArmor
(`sysctl kernel.apparmor_restrict_unprivileged_userns=0` lifts that, as does an AppArmor profile for
the Chromium binary). Where the sandbox cannot start, `sandburg` stops before the first run and says
what to change. It does not fall back on its own. To run without the sandbox, say so:
`--no-browser-sandbox`, `SANDBURG_NO_BROWSER_SANDBOX=1`, or `new Session({ browserSandbox: false })`
(`--browser-sandbox` asks for the sandbox where the environment variable turns it off).
The CLI warns, and each `result.json` (`environment.browserSandbox`) and batch `summary.json`
(`browserSandbox`) records it.

The study method and every report are in [`docs/fidelity`](docs/fidelity/README.md).

## Development

```sh
npm test               # unit tests
npm run lint           # oxlint (type-aware, with Sandburg's own rules) and knip
npm run test:runtime   # the runtime's loader and built-ins, in Chromium
npm run test:e2e       # fixtures end to end (the first run needs network access; Docker tests skip without Docker)
npm run typecheck
npm run build          # dist/: the CLI and library as JavaScript, with types (npm pack runs it)
npm run test:pack      # pack the package, install it into an empty project, run a project with it
node scripts/pages/build.ts --verify   # the demo site, into dist-pages/
node scripts/profile.ts <project>      # where a run's time goes: V8 CPU profile of every thread, by package
node scripts/bench.ts                   # A/B benchmark of two revisions (default origin/main vs this checkout), cold and warm
node scripts/edit-loop.ts               # edit-to-render latency of the fixtures
node scripts/flakes.ts --cpu 4 <files>  # run test files again and again under load, and count what fails
node scripts/architecture.ts --update   # regenerate docs/architecture.md's tables (the unit tests compare them)
node scripts/api-report.ts --update     # regenerate api/sandburg.api.md after a change to the public API
```

How to keep tests reliable (waiting for the thing, not for a time; hermetic temp dirs and ports) is in
[`docs/testing.md`](docs/testing.md) ([ADR 0060](docs/adr/0060-test-reliability-under-load.md)).

The demo site replays the host's answers from static files, recorded when the site is built
([ADR 0015](docs/adr/0015-static-demos.md)). The generator page installs and compiles in the page, so it
only needs the runtime's own files ([ADR 0021](docs/adr/0021-generate-in-the-browser.md));
`--verify` runs each of its framework scaffolds, and `--only generate` builds it alone. A GitHub Actions
workflow builds and deploys the site on every push to `main`.

CI runs on every pull request and push to `main`. It runs typecheck, lint and unit tests on Node 24 (LTS),
the runtime tests in Chromium, the packed package, and each e2e file as its own job; the Docker reference tests run there too. Each
job reports its tests' times, with a warning annotation for a file over its budget in `test/budgets.json`.
A pull request that changes `src/`, `pages/`, `scripts/bench.ts`, `package-lock.json` or the perf workflow
is also benchmarked against its base branch: `vite-react-counter` and `next-app-router`, warm and cold.
That job fails only when a median is more than 30% slower, or when a side has no result. zizmor checks the workflows, and Dependabot proposes npm and GitHub Actions updates weekly,
after a week's cooldown. Every action is pinned to a commit.

A pull request that changes what the package does adds a changeset (`npx changeset`): the bump and a line
for the changelog ([`.changeset/`](.changeset)). The Release workflow gathers them on `main` into a
"Version packages" pull request; merging it tests and stages that version on npm with npm's trusted
publishing (no npm token in the repository) and provenance, tags it and creates its GitHub release. The
version goes public once a maintainer approves the staged publish on npmjs.com.

On networks that re-terminate TLS, Sandburg trusts the CAs in `$SANDBURG_EXTRA_CA_CERTS` (or
`$NODE_EXTRA_CA_CERTS`) in the browser too, by pinning their public keys. Certificate verification
stays on.

## License

Apache-2.0.
