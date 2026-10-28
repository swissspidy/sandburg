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
- **Correct answers.** Tested on 232 generated apps in 14 frameworks with known faults (study v7), it gets 224
  right and catches every fault. The 8 false alarms are Sandburg bugs, 6 of them Lit apps that render only
  into a shadow root. `sandburg compare` measures agreement with a Docker reference.
- **Fast after the first run.** Installs, compiled modules, and dev-server caches carry over between
  runs and between projects that share packages.
- **Contained.** A sandbox reaches the network only through a caching gateway and a per-sandbox
  allowlist, and tests prove it.

| 232-app study ([v7](docs/fidelity/v7-node-vs-truth.md), 2026-10-28, 4 vCPU, 3 tabs at a time) | Median run, cold | Median run, warm |
|---|---|---|
| Vite, vanilla (33 apps) | 3.9 s | 3.9 s |
| Vite + React (34) | 12.6 s | 4.4 s |
| Next.js 15 (33) | 11.9 s | 11.0 s |
| 11 more frameworks (12 apps each; per framework in the study) | 9.3 s | 9.3 s |
| All 232 | 9.6 s | 8.2 s |
| Whole corpus, 3 tabs | 1,776 s | 1,497 s |

A run includes the install, the dev server's start, the first render and the checks. "Cold" starts
from empty Sandburg caches (npm's own cache warm). More than half the corpus's run time went to runs
that waited out a 240 s deadline (see the study). The fixtures on 2026-10-26, at 8dda85e: a one-off run of `node scripts/bench.ts` on a
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

Sandburg drives Chromium with the Playwright it installs. If that Chromium is missing, the run stops and
prints the command that installs it ([Troubleshooting](docs/guide/troubleshooting.md#chromium-is-not-installed)).

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

`<project>` is a directory, a `.zip`, a JSON file tree or `snapshot:<id>`. Every run has built-in checks (a
server error or an uncaught error fails it); a checks file adds named checks with Playwright's `expect`.
Exit codes: `0` passed, `1` a blocking check failed, `2` the run did not reach the checks, `64` a usage
error.

## Guides

- [Writing checks](docs/guide/writing-checks.md): the Checks API, time limits, what is reset between
  checks, `--checks-in page`, the built-in checks.
- [CLI](docs/guide/cli.md): every command and option, project inputs, snapshots, `--offline`,
  `--install-in browser`, `--save-files`, exit codes.
- [Library](docs/guide/library.md): `Session`, `RunOptions`, `result.json` and the failure classes.
- [Agents and CI](docs/guide/agents-and-ci.md): calling Sandburg from a coding agent, the GitHub Action,
  reading results.
- [Troubleshooting](docs/guide/troubleshooting.md): installing Chromium, the browser sandbox, what is
  not supported, reading a failure.
- [Security](docs/guide/security.md): the sandbox's layers, the egress model, checks files and the
  Docker reference.

## What runs

| | |
|---|---|
| Front ends | Vite 5–8 with its plugins (React, Vue, Svelte, Solid, Preact, Lit, Tailwind), SvelteKit 3, Astro 7, Nuxt 4, React Router 8, SolidStart 2; `next dev` (Next.js 15–16, App and Pages Router, webpack, SWC); `ng serve` (Angular 22); static sites. Each framework is one entry of the table in [`src/framework.ts`](src/framework.ts), which also sets the order detection tries them in |
| Back ends | Express and other Node servers next to the front end, reached through Vite's proxy, from the page (`http://localhost:<port>`) or over WebSockets; SQLite (`better-sqlite3`, `sqlite3`, `node:sqlite`) |
| Dev scripts | `&&`, `\|\|`, `;`, `&`, `cd`, `VAR=value`, `cross-env`, npm/pnpm/yarn scripts, package binaries, `concurrently`; `tsx`, `ts-node` and `nodemon` run their file directly; a workspace's script (`npm -w`, `pnpm --filter`, `yarn workspace`) |
| Dependencies | npm registry versions, at a package-lock.json's versions, or pinned from a pnpm-lock.yaml or yarn.lock; npm, pnpm and yarn workspaces, and `file:`, `link:` and `workspace:` packages inside the project, linked ([ADR 0064](docs/adr/0064-monorepos-and-local-packages.md)). `sandburg run mono/apps/web` runs a workspace package in its monorepo (it loads all of the monorepo's files) |
| Node APIs | `fs`, `http`, `worker_threads`, `child_process` (Node programs), `node:wasi`, `AsyncLocalStorage` across native `await`s ([ADR 0057](docs/adr/0057-native-awaits-and-the-runtime-warm-path.md)), top-level await, WebSockets. Native tools run on their WebAssembly builds: SWC, rolldown, rollup, esbuild, lightningcss, Tailwind's oxide; TypeScript 7's `tsc` runs tsrs ([ADR 0024](docs/adr/0024-typescript-7.md)) |
| Not supported | Native addons without a WebAssembly build, programs other than Node (`git`, `python` exit with 127, also under `execSync`/`spawnSync`), servers started synchronously (`execSync('npm run dev')` blocks with a server nothing reaches), dependencies that are neither npm registry versions nor packages inside the project (git, URL, `user/repo` shorthands, local tarballs, paths outside the project: the run fails before installing, as `runtime-unsupported`) |

## How it works

The host (Node.js) installs the project's packages with npm and serves them to the browser. The runtime is
Node.js 24 in a Web Worker, and runs the project's dev script. A service worker gives the app its origin
and routes its requests to the servers in the runtime. Playwright runs the checks in the app's frame.
The map of the code is [`docs/architecture.md`](docs/architecture.md), and the design decisions are in
[`docs/adr`](docs/adr/README.md). The study method and every report are in
[`docs/fidelity`](docs/fidelity/README.md).

## Security

An app runs in a tab of its own: its own browser context and origin, every request through the egress
gateway or the sandbox's egress proxy, both held to its allowlist, inside Chromium's OS sandbox. Where that sandbox cannot start,
`sandburg` stops and says what to change; `--no-browser-sandbox` turns it off, explicitly. A checks file
runs with Sandburg's own rights unless `--checks-in page`. The Docker reference is not a security
boundary. The details are in [Security](docs/guide/security.md).

## Development

How to contribute (setup, tests, changesets, ADRs, pull requests) is in [CONTRIBUTING.md](CONTRIBUTING.md).

`npm test`, `npm run lint` and `npm run typecheck` are the fast checks; the other suites, the scripts,
CI and the release flow are in [`docs/development.md`](docs/development.md).

## License

Apache-2.0.
