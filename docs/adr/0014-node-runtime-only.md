# ADR 0014: The node runtime runs every project; esbuild and angular adapters removed

- Status: Accepted
- Date: 2026-09-30
- Supersedes: [ADR 0007](0007-esbuild-adapter.md), [ADR 0008](0008-angular.md), [ADR 0011](0011-client-frameworks.md). Amends [ADR 0009](0009-full-stack-vue-sqlite.md) and [ADR 0013](0013-runtime-consolidation.md) (`--runtime auto` removed).

## Context

After ADR 0013 three adapters were left, and `--runtime auto` chose between them:

- **esbuild** (ADRs 0007, 0009, 0011) rebuilt what Vite and its plugins do: it bundled
  client-side apps with esbuild-wasm and compiled Vue, Svelte and Solid with the apps' own
  compilers. It was fast (3–10 s), but it was a second implementation of Vite. Every plugin,
  PostCSS setup or Tailwind v3 project it did not reimplement was rejected as unsupported, and
  what it ran was not what `vite` runs.
- **angular** (ADR 0008) ran the app's own `@angular/compiler-cli` in the node runtime and
  reimplemented the rest of `@angular/build`: linking, bundling, styles.
- **node** (ADRs 0006, 0012) ran the real tools: `next dev`, Vite 8 and the meta-frameworks
  built on it.

The two partial adapters existed because the node runtime could not yet run everything: dev
scripts that start several programs (`concurrently "vite" "node server"`), Vite versions whose
esbuild needed a file system, `ng serve` and its worker pool. Keeping them meant a project's
result depended on which adapter `auto` chose, and every framework feature had to be built twice.

## Decision

**One runtime.** Every project runs on the node runtime with the tools its `package.json` names.
The esbuild and angular adapters, `--runtime auto` and the runtime choice are removed.
`--runtime` stays as an option and has one value, `node`.

**Dev scripts run through a shell** (`src/node-runtime/shell.ts`). `child_process` with
`shell: true`, and any program that is not `node`, go to a small POSIX-style shell. It supports:

- `&&`, `||`, `;`, `&`, `$VAR` and `${VAR:-default}`, quotes, `NAME=value cmd`;
- `cd`, `export`, `echo`, `true`, `false`, `exit`, `sleep`, `cross-env`, `env`, `sh -c`;
- npm, pnpm, yarn and bun scripts (with `--prefix`/`-C`/`--cwd`, `pre` scripts and `--` arguments),
  and `npx`/`npm exec`/`dlx`;
- package binaries, from a `node_modules/.sandburg-bins.json` that the host writes at install.

`tsx`, `ts-node`, `nodemon` and similar run their file directly with the runtime's own TypeScript
support: they hook Node's loaders and spawn watchers, and `tsx` needs esbuild's synchronous API,
which the WebAssembly build cannot offer in the browser. Pipes and redirections run the first
command only, with a note. There are no other programs: `git`, `python` or `docker` exit with 127,
as a shell reports a command it cannot find.

**Projects with several packages.** Every directory with a `package.json` (one level down, unless
the root's npm workspaces install them) is installed as its own npm project, and the installs are
served as one tree (`client/node_modules/…`, `server/node_modules/…`).

**Which server is the page.** A single command starts directly, as before. A compound dev script
runs as `.sandburg/start.js`, which spawns it through the shell. The app is the first server that
answers `GET /` with HTML, so an API that listens first is not taken for the page. `PORT` is not
set for a compound script; its servers listen where the project says.

**Servers reach each other.** A request from one runtime to a localhost port that another runtime
serves goes up to the parent runtime and down to the one that serves it. So Vite's `/api` proxy
reaches the backend that `concurrently` started next to it. The page's own calls to
`http://localhost:<port>` (a CORS API) go to that port's server through `/__sandburg_backend/<port>/`,
rewritten in the page by the WebSocket shim. WebSockets that Vite's proxy would forward
(`'/socket.io': { ws: true }`) go to the backend directly.

**A crash is a failure.** If a command of the dev script exits with an error while the rest comes
up (`concurrently` keeps the others running), the start fails as an app bug with that command's
last error output. A dev server that reports a failed first build and waits for changes
(`ng serve`) also ends the start. Compile errors that Vite and esbuild print (`Internal server
error`, `Pre-transform error`, `✘ [ERROR]`, with `File: /app/<path>:<line>:<column>`) are
classified as `compile-error` app bugs at that location.

**Runtime fixes this needed**

- esbuild's WebAssembly build under the runtime: Go's file system is the runtime's `fs`, and
  `write: true` (the default under Node) writes the output files. Vite 5's dependency optimizer
  and config loading depend on both.
- piscina (the Angular CLI's worker pool) waits for tasks with `Atomics.wait` and reads them with
  `receiveMessageOnPort`, which needs a synchronous look into a `MessagePort`; browsers have none.
  Its workers are switched to their message-event mode when their source is served, as under
  WebContainers. `worker_threads` MessagePorts are EventEmitters (`port.on('message')`), and
  `events.EventEmitterAsyncResource` exists.
- `import()` inside `new Function` source and in plain CommonJS files goes through the runtime's
  loader with import conditions. A module with top-level await is thenable until it has
  evaluated, so `await import()` from CommonJS waits for it.
- The reported Node.js version is 24.15.0 (the Angular CLI 22 refuses 24.11). The main program
  exits when its event loop is empty, as child processes already did.
- The service worker's requests carry a `Host` header (Vite 5's `allowedHosts` check rejects a
  request without one). Worker threads find the `node_modules` of `client/` and `server/`.

**Speed.** Vite's pre-bundled dependencies (`node_modules/.vite/deps` of each package) are kept on
the host after a run and restored before the next run of a project with the same installed
packages and the same imported packages. Vite checks the cache against the lockfile and its config
before it uses it.

## Consequences

- One code path for every framework: a project runs with the versions of Vite, its plugins, the
  Angular CLI or Next.js that it installs. Vite plugins, PostCSS and Tailwind v3 are no longer
  rejected, and Angular apps get `ng serve`'s own behavior (styles, budgets, HMR, error overlay).
- About 2,200 lines of adapter code are gone: the esbuild build, its resolver, its Vue, Svelte,
  Solid and Tailwind integrations, and the Angular adapter's build.
- Client-side Vite apps take longer than on the esbuild adapter: they now start a real dev server.
  See the measurements below.
- Sass importers in Angular (`@use` of a package) send each import to the main thread and wait
  for the answer with `Atomics.wait` and `receiveMessageOnPort`. That needs a synchronous
  `MessagePort`, which the runtime does not have yet. Relative `@use` and plain SCSS work.
- Scripts that pipe or redirect output run only their first command.

## Measurements

MEASUREMENTS
