# ADR 0009: Full-stack apps (front end + Node backend), Vue, and SQLite in WebAssembly

- Status: Accepted
- Date: 2026-09-30

## Context

Generated apps are often full stack:
- a Vite front end (React, Vue),
- an Express backend,
- `concurrently` in the `dev` script to start both,
- Vite's `server.proxy` sending `/api` to `http://localhost:3001`, or the
  front end calling that URL directly with CORS,
- one package, or `client/` and `server/` packages,
- SQLite as the database, most often through `better-sqlite3` (a native
  addon), `sqlite3` (native) or `node:sqlite`.

Sandburg already had the parts: the esbuild adapter builds Vite front ends
(ADR 0007), and the node runtime runs Express (ADR 0006). What was missing:
running both in one sandbox with requests routed between them, Vue
single-file components, and a database. We only need SQLite; other
databases are out of scope.

## Decision 1: One sandbox, two halves, routed like Vite's dev server

The esbuild adapter now detects a backend (`src/adapters/esbuild/backend.ts`,
a pure function over the project files):

- **Finding the commands.** It follows the root `dev` (or `start`) script
  through:
  - `npm run` and `npm --prefix dir`/`-C`/`--dir`,
  - `cd dir &&`,
  - `concurrently` (including `npm:name` and wildcards),
  - `npm-run-all`/`run-p`,
  - `cross-env` and `VAR=` prefixes,
  - `&&` and `&`.

  The first command run by `node`, `nodemon`, `tsx`, `ts-node` (or similar)
  is the backend. Its entry comes from the command line. A `server/`,
  `backend/` or `api/` package that the root does not start is found too.
  The front end is where `vite` runs, or the first of `.`, `client/`,
  `frontend/`, `web/` … with an `index.html`.
- **Installs.** The host installs each package directory once (shared
  cache, `--ignore-scripts`). Each half sees its own package as the project
  root.
- **Start.** The backend starts first, in a Node.js runtime worker (the
  shared `NodeProcess` client, which the node adapter now uses too), and the
  adapter waits until it listens. Then the front end is built, and the
  service worker is connected.
- **Routing.** The service worker hands every request to the host page,
  which sends it to one of two places:
  - The backend, if it matches Vite's `server.proxy` from vite.config
    (string targets or `{ target, rewrite }` pointing at localhost). The
    common `rewrite: (p) => p.replace(/^\/api/, '')` strips the prefix. If
    the backend listens on another port than the proxy names, requests go
    to the port it does listen on.
  - Otherwise the build output, `public/` and project files, as before.

  Calls to `http://localhost:<port>` or `127.0.0.1:<port>` (from `fetch`,
  `XMLHttpRequest`/axios or `EventSource`) are rewritten in the page to
  `/__sandburg_backend/<port>/…` for the backend's ports, by a small script
  injected first into `index.html`. So a front end that calls
  `import.meta.env.VITE_API_URL` directly works without a proxy, and
  nothing leaves the sandbox. CORS no longer applies, because the request is
  now same-origin.
- **TypeScript runners.** For `tsx`/`ts-node` backends, `./x.js` imports
  from TypeScript files resolve to `./x.ts`, as those runners do. Plain
  `node` keeps Node's stricter behavior.
- **Failures.** A backend that crashes or exits before listening is an
  `APP` error, so it is classified as an app bug in `start`, with its stack.
  If the runtime could not load its own parts, that is infra.

## Decision 2: Vue single-file components with the app's own compiler

`.vue` files are compiled in the build (`src/adapters/esbuild/vue.ts`) with
the app's installed `@vue/compiler-sfc`, bundled and imported in the page
as Tailwind is (ADR 0007). It works like `@vitejs/plugin-vue`:
- `<script setup>` with the template inlined (`genDefaultAs`, types
  resolved from project files for `defineProps<…>()`),
- plain `<script>` with a separate `render`,
- scoped styles with a per-file `data-v-…` id,
- TypeScript blocks given to esbuild,
- the Vue feature flags defined.

`@vitejs/plugin-vue` is now accepted by the probe. Not covered yet:
`<style lang="scss">`, `<style module>`, and `src=` blocks. These are
build errors with a clear message.

## Decision 3: SQLite is the real SQLite, compiled to WebAssembly

The runtime loads the official build (`@sqlite.org/sqlite-wasm`,
Apache-2.0) with `importScripts`, before the program starts, when the
project uses SQLite. That means an installed `better-sqlite3` or `sqlite3`,
or `node:sqlite` in the sources. The APIs are synchronous, so the engine
must be ready first. On top of it (`src/node-runtime/builtins/sqlite/`):

- **better-sqlite3** is complete for typical use. When the loader resolves
  the installed package, it returns this module instead of loading the
  native addon.
  - Statements: `run` (`changes`, `lastInsertRowid`), `get`, `all`,
    `iterate`, `pluck`, `raw`, `expand`, `safeIntegers`, `bind`,
    `columns`.
  - Parameters: named (`@`, `:`, `$`) and positional.
  - `transaction()` with nested savepoints and its
    deferred/immediate/exclusive variants, `pragma`, `function`,
    `serialize`.
  - Errors are `SqliteError` with SQLite's extended codes
    (`SQLITE_CONSTRAINT_UNIQUE`) and messages
    (`UNIQUE constraint failed: users.email`), and misuse errors match
    better-sqlite3's.
- **sqlite3** has the callback API: `run` with `this.lastID`/`changes`,
  `get`, `all`, `each`, `exec`, `prepare`/Statement, `serialize`, `close`,
  and `cached`. Callbacks run asynchronously in call order. Errors look like
  `SQLITE_CONSTRAINT: …`.
- **node:sqlite** provides `DatabaseSync` and `StatementSync` with Node's
  defaults:
  - foreign keys on,
  - bare named parameters,
  - null-prototype rows,
  - errors with `code: 'ERR_SQLITE_ERROR'`.

**Storage.** A database file is one in-memory database shared by every
connection to that path, as a file on disk would be. After writes, and
outside transactions, it is serialized back to its file in the virtual file
system, so `fs` sees a real `SQLite format 3` file. A `.db` file shipped
with the project is loaded when first opened. `journal_mode = WAL` is
accepted, but the in-memory database reports `memory`.

## Consequences

- New fixtures pass all their checks, in about 6–7 s each with a cached
  install:
  - `vue-express-sqlite`: Vue 3 SFCs (one in TypeScript, with scoped
    styles), Express 5, better-sqlite3 with a transaction seed,
    `concurrently`, and a `/api` proxy. A note survives a page reload
    because it is in the database.
  - `react-express-split`: `client/` React plus axios calling
    `http://localhost:4000` through `VITE_API_URL`; `server/` TypeScript
    Express under `tsx watch`, using `node:sqlite` and `cors`; a UNIQUE
    constraint surfacing as HTTP 409.
- Runtime tests cover the three SQLite APIs, and unit tests cover script and
  proxy detection.
- WebSockets (socket.io, Vite's `ws: true` proxies) and top-level `await` in
  ESM backends were added later (ADR 0010).
- Not covered:
  - backends that run Vite as middleware (`createServer({ server: {
    middlewareMode } })`),
  - Next.js/Nuxt-style meta-frameworks (other runtimes),
  - databases other than SQLite,
  - ORMs with native engines (Prisma). ORMs that use better-sqlite3 or
    sqlite3 (Drizzle, Knex, Sequelize) should work through these
    modules, but none has been tested yet.
