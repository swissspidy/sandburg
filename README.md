# Sandburg

[![CI](https://github.com/swissspidy/sandburg/actions/workflows/ci.yml/badge.svg)](https://github.com/swissspidy/sandburg/actions/workflows/ci.yml)

Run and test generated web apps inside the browser.

Sandburg takes a web project, starts it with its own dev server on a Node.js runtime that runs in a
browser tab, and checks it end to end with Playwright in the same tab. It needs no container or VM
per run: one browser runs many sandboxes side by side, each on its own origin.

**[Try the demos →](https://swissspidy.github.io/sandburg/)** Next.js, Vite + React, SvelteKit, Angular and a
Vue + Express + SQLite app, running in your browser.

## At a glance

- **The project's own tools.** `next dev`, Vite 5–8 with its plugins, `ng serve`, Express, and a dev
  script as written (`concurrently "vite" "node server"`). There is no reimplementation of a framework's build.
- **Correct answers.** Tested on 100 generated apps with known faults, it gets 97 right, with no false
  alarms. The three misses are mislabelled apps. `sandburg compare` measures agreement with a Docker
  reference.
- **Fast after the first run.** Installs, compiled modules, and dev-server caches carry over between
  runs and between projects that share packages.
- **Contained.** A sandbox reaches the network only through a caching gateway and a per-sandbox
  allowlist, and tests prove it.

| 100-app study ([v6](docs/fidelity/v6-node-vs-truth.md)) | Median run, cold | Median run, warm |
|---|---|---|
| Vite, vanilla (33 apps) | 3.4 s | 3.2 s |
| Vite + React (34) | 16.1 s | 5.9 s |
| Next.js 15 (33) | 14.4 s | 13.0 s |
| All 100 | 13.2 s | 6.5 s |
| Whole corpus, 3 tabs | 533 s | 289 s |

A run includes the install, the dev server's start, the first render and the checks. "Cold" starts
from empty Sandburg caches. A Next.js app that has never run, with a new install, runs in
15.7 s, down from about 45 s. Its first compile takes 2.2 s, where native `next dev` on the same
machine takes 3.9 s ([ADR 0014](docs/adr/0014-node-runtime-only.md)). Since study v6, a profile of the runtime made warm
Next.js runs a third faster, 11.9 s to 8.0 s ([ADR 0017](docs/adr/0017-runtime-profile.md)).

## Quick start

Requires Node.js 22.18 or later and a Chromium that Playwright 1.56 can launch.

```sh
npm install
npx playwright install chromium        # or set SANDBURG_CHROMIUM=/path/to/chrome
node bin/sandburg.js run fixtures/vite-react-counter --checks fixtures/vite-react-counter/checks.spec.ts
```

## CLI

```sh
sandburg run <project> [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                     # each subdirectory is a project
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
- Exit codes: `0` passed, `1` a blocking check failed, `2` the run did not reach the checks.

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
| Front ends | Vite 5–8 with its plugins (React, Vue, Svelte, Solid, Preact, Lit, Tailwind), SvelteKit, Astro, Nuxt, React Router, SolidStart; `next dev` (Next.js 15–16, webpack, SWC); `ng serve` (Angular 22); static sites |
| Back ends | Express and other Node servers next to the front end, reached through Vite's proxy, from the page (`http://localhost:<port>`) or over WebSockets; SQLite (`better-sqlite3`, `sqlite3`, `node:sqlite`) |
| Dev scripts | `&&`, `\|\|`, `;`, `&`, `cd`, `VAR=value`, `cross-env`, npm/pnpm/yarn scripts, package binaries, `concurrently`; `tsx`, `ts-node` and `nodemon` run their file directly |
| Node APIs | `fs`, `http`, `worker_threads`, `child_process` (Node programs), `node:wasi`, top-level await, WebSockets. Native tools run on their WebAssembly builds: SWC, rolldown, rollup, esbuild, lightningcss, Tailwind's oxide |
| Not supported | Native addons without a WebAssembly build, synchronous child processes, programs other than Node (`git`, `python` exit with 127) |

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

The design decisions are recorded in [`docs/adr`](docs/adr). [ADR 0006](docs/adr/0006-node-runtime.md)
covers the runtime, and [ADR 0014](docs/adr/0014-node-runtime-only.md) covers the single runtime and the
cold-start work. The study method and every report are in [`docs/fidelity`](docs/fidelity/README.md).

## Development

```sh
npm test               # unit tests
npm run test:runtime   # the runtime's loader and built-ins, in Chromium
npm run test:e2e       # fixtures end to end (the first run needs network access; Docker tests skip without Docker)
npm run typecheck
node scripts/pages/build.ts --verify   # the demo site, into dist-pages/
node scripts/profile.ts <project>      # where a run's time goes: V8 CPU profile of every thread, by package
node scripts/edit-loop.ts               # edit-to-render latency of the fixtures
```

The demo site replays the host's answers from static files, recorded when the site is built
([ADR 0015](docs/adr/0015-static-demos.md)). A GitHub Actions workflow builds and deploys it on every
push to `main`.

CI runs on every pull request and push to `main`. It runs typecheck and unit tests on Node 24 (LTS),
the runtime tests in Chromium, and each e2e file as its own job; the Docker reference tests run there
too. zizmor checks the workflows, and Dependabot proposes npm and GitHub Actions updates weekly,
after a week's cooldown. Every action is pinned to a commit.

On networks that re-terminate TLS, Sandburg trusts the CAs in `$SANDBURG_EXTRA_CA_CERTS` (or
`$NODE_EXTRA_CA_CERTS`) in the browser too, by pinning their public keys. Certificate verification
stays on.

## License

Apache-2.0.
