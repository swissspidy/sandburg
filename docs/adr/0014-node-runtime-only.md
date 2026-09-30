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
- `receiveMessageOnPort` takes a message synchronously, while the thread is blocked in
  `Atomics.wait`; a browser delivers messages only through its event loop. Each `MessageChannel`
  made in the runtime therefore also has a mailbox in shared memory
  (`src/node-runtime/message-ports.ts`). A sender numbers every message and also writes it there
  when it can be encoded as JSON. `receiveMessageOnPort` reads the mailbox, and the event loop
  skips what was read. The mailbox travels with a transferred port. Angular's Sass worker needs
  this: it asks the main thread to resolve each `@use` of a package this way.
- piscina (the Angular CLI's worker pool) can wait for tasks the same way, but in a loop that
  never lets its event loop run. Its workers are switched to their message-event mode when their
  source is served, as under WebContainers. `worker_threads` MessagePorts are EventEmitters
  (`port.on('message')`), and `events.EventEmitterAsyncResource` exists.
- `import()` inside `new Function` source and in plain CommonJS files goes through the runtime's
  loader with import conditions. A module with top-level await is thenable until it has
  evaluated, so `await import()` from CommonJS waits for it.
- `sass-embedded` runs Dart Sass as a native program over a pipe; the Angular CLI 22 and Vite
  prefer it when it is installed. It is replaced at install by `sass`, the same compiler compiled
  to JavaScript, with the same API (as WebContainers do).
- The reported Node.js version is 24.15.0 (the Angular CLI 22 refuses 24.11). The main program
  exits when its event loop is empty, as child processes already did.
- The service worker's requests carry a `Host` header (Vite 5's `allowedHosts` check rejects a
  request without one). Worker threads find the `node_modules` of `client/` and `server/`.

**Disk.** An install records its layout version, and installs of an earlier layout are removed.

**Speed.** Vite's pre-bundled dependencies (`node_modules/.vite/deps` of each package) are kept on
the host after a run and restored before the next run of a project with the same installed
packages and the same imported packages. Vite checks the cache against the lockfile and its config
before it uses it.

The runtime reads installed files with one synchronous request each, about 7 ms apiece: `next dev`
loads ~1,750 files (12 s of its start), svelte-vite's Vite ~700 in each of two runtimes. The host
records which files an install's runs load, and a later run fetches them as one bundle. A runtime
switches to the bundle after its first 40 files, so the small WebAssembly helper threads do not each
hold it; the browser caches the bundle for the other runtimes of the run. Measured: svelte-vite 16.3 s
→ 7.5 s, Next.js 33.1 s → 21.4 s.

Two other ideas were measured and dropped. Compiling WebAssembly is not a cost worth caching: V8
compiles lazily, and rolldown's 10.8 MB binding or SWC's 27.8 MB take 20–60 ms. napi-rs's thread
pool has 4 threads, as in Node, and `os.availableParallelism()` reports the browser's cores, so
there is no idle parallelism to add on the machines measured.

## Consequences

- One code path for every framework: a project runs with the versions of Vite, its plugins, the
  Angular CLI or Next.js that it installs. Vite plugins, PostCSS and Tailwind v3 are no longer
  rejected, and Angular apps get `ng serve`'s own behavior (styles, budgets, HMR, error overlay).
- About 2,200 lines of adapter code are gone: the esbuild build, its resolver, its Vue, Svelte,
  Solid and Tailwind integrations, and the Angular adapter's build.
- Client-side Vite apps take longer than on the esbuild adapter: they now start a real dev server.
  See the measurements below.
- `receiveMessageOnPort` can only take messages that can be encoded as JSON; it returns nothing
  for the others (typed arrays, shared memory, ports), which arrive through the event loop.
- Scripts that pipe or redirect output run only their first command.

## Measurements

**The 100-app corpus** ([study v4](../fidelity/v4-node-vs-truth.md), against ground truth): 97/100
right, the same answers as `--runtime auto` in v3, with no false alarms; all 27 caught faults are
classified `app-bug`.

| Apps | v3 (`auto`), median run | v4 (node), median run | v4, median of a repeat run |
|---|---|---|---|
| vite-vanilla (33) | 2.7 s | 3.9 s | 3.4 s |
| vite-react (34) | 13.4 s | 33.0 s | 9.1 s |
| nextjs (33) | 38.4 s | 40.4 s | |

Both studies installed dependencies cold. A first run of a vite-react app is slower on real Vite:
Vite 6 pre-bundles `lucide-react` with esbuild's WebAssembly build, in one thread. A repeat run keeps
the install and Vite's pre-bundled dependencies.

**Fixtures** (installs cached, from the e2e suite on the same machine):

| Fixture | Run |
|---|---|
| lit-vite, Tailwind v4 on Vite | 4.5 s, 4.7 s |
| vite-react-counter (Vite 5) | 6.3 s |
| solid-vite, preact-vite | 8.0 s, 8.5 s |
| socket.io chat, Vue + Express + SQLite, React + Express (`client/` + `server/`) | 11–12 s |
| svelte-vite | 17.9 s |
| angular-tasks (Angular 22), angular-19-zone | 28 s, 40 s |
| Next.js 15 | 33 s |
