# Sandburg

Run and test generated web apps inside the browser.

Sandburg takes a generated web project, runs it in an in-browser runtime, and
checks it end to end in the same browser tab. It needs no container or microVM
per run. Think of it as WordPress Playground, generalized to JavaScript apps.

- **One tab = one sandbox = one origin.** Many run in parallel in one browser.
- **Runtimes chosen per project** (`--runtime auto`, the default):
  Sandburg's own Node.js 24 runtime runs real dev servers (Next.js; Vite 8
  with SvelteKit, Astro, Nuxt, React Router and SolidStart; Express; SQLite
  via WebAssembly). An esbuild-wasm build is the fast path for client-side
  Vite apps (React, Vue, Svelte, Solid, Preact, Lit, Tailwind v4), with an
  Express backend in the same sandbox if there is one. Angular apps are
  compiled AOT with the app's own compiler.
- **Honest about fidelity:** `sandburg compare` runs the same apps in a Docker
  reference and reports how often the two agree, and why they disagree.
- **Nothing leaves the browser** except through a caching egress gateway and a
  per-sandbox filtering proxy, both enforcing a per-runtime allowlist. Tests
  prove it.

## Status

| Milestone | State |
|---|---|
| 1. Vite + React spike | done ([ADR 0001](docs/adr/0001-runtime-adapters-serving-results.md)) |
| 2. Parallel batches, cache, network containment | done ([ADR 0002](docs/adr/0002-snapshots-and-batches.md)) |
| 3. Next.js on almostnode; Nodebox adapter | done, since removed ([ADR 0003](docs/adr/0003-nextjs-and-nodebox.md), [ADR 0013](docs/adr/0013-runtime-consolidation.md)) |
| 4. Fidelity study vs Docker | done ([ADR 0004](docs/adr/0004-docker-reference-and-fidelity-study.md), [reports](docs/fidelity/README.md)) |
| 5. WordPress Playground | done, since removed ([ADR 0005](docs/adr/0005-wordpress-playground.md), [ADR 0013](docs/adr/0013-runtime-consolidation.md)) |
| 6. Own Node.js runtime: real Next.js in the browser | done ([ADR 0006](docs/adr/0006-node-runtime.md)) |
| 7. esbuild-wasm adapter for Vite-style apps | done ([ADR 0007](docs/adr/0007-esbuild-adapter.md)) |
| 8. Angular | done ([ADR 0008](docs/adr/0008-angular.md)) |
| 9. Full-stack apps (front end + Express), Vue, SQLite | done ([ADR 0009](docs/adr/0009-full-stack-vue-sqlite.md)) |
| 10. WebSockets and hot reloading; top-level await | done ([ADR 0010](docs/adr/0010-websockets-and-top-level-await.md)) |
| 11. Svelte, Solid, Preact, Lit | done ([ADR 0011](docs/adr/0011-client-frameworks.md)) |
| 12. Real Vite: SvelteKit, Astro, React Router, Nuxt, SolidStart | done ([ADR 0012](docs/adr/0012-real-vite-and-meta-frameworks.md)) |
| 13. One Node.js runtime; `--runtime auto`; almostnode and Nodebox removed | done ([ADR 0013](docs/adr/0013-runtime-consolidation.md)) |

## Try it

Requires Node.js 22.18 or later, which runs the TypeScript sources directly.
It also needs a Chromium that Playwright 1.56 can launch.

```sh
npm install
npx playwright install chromium   # or set SANDBURG_CHROMIUM=/path/to/chrome
npm run spike                      # the Vite + React fixture
```

## CLI

```sh
sandburg run <project> [--runtime auto|node|esbuild|angular] [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                    # each subdirectory is a project
sandburg compare <dir> --reference docker [--report path]
sandburg snapshot <project>                            # store it, print its snapshot id
sandburg open <project>                                # load it in a visible tab
```

- `<project>` is a directory, a `.zip` (a single top-level folder is stripped, as in GitHub downloads), a JSON file tree (`{ "path": "contents" }`), or
  `snapshot:<id or prefix>`. Every run stores its project as a
  content-addressed snapshot, and the result records the snapshot id, so any
  run can be reopened exactly (`sandburg open snapshot:3f2a…`).
- A checks file default-exports an object that maps check names to
  functions. Each function gets the app frame, Playwright's `expect`, and
  `appUrl(path)`, which resolves a path under whatever prefix the runtime
  serves the app at:

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
- `--offline` answers every request from the HTTP cache (`.sandburg/cache`)
  and fails on a miss.
- Exit codes: `0` passed, `1` failed (the app ran but a blocking check
  failed), `2` error (the run did not reach the checks).

## Library

```ts
import { Session, dockerReference } from 'sandburg';

const session = new Session();
await session.open();
const result = await session.run('./project', { checks: './checks.spec.ts' });
const reference = await session.run('./project', { nodeRuntime: dockerReference(), checks: './checks.spec.ts' });
await session.close();
```

Each run writes `result.json` (schema:
[`src/result-schema.json`](src/result-schema.json)), `screenshot.png`,
`a11y.yaml`, and, for the Docker reference, `runtime.log`, to
`.sandburg/runs/<runId>/`. Each failure is classified as
`runtime-unsupported`, `app-bug`, `timeout`, `infra` or `unknown`, and names
the rule that decided it (`src/classify.ts`).

## Runtimes

`--runtime auto` (the default) picks one per project: `angular` for Angular CLI apps, `esbuild` for
projects it can build, and `node` for everything else (ADR 0013).

| Runtime | Runs | Notes |
|---|---|---|
| `angular` | Angular CLI apps (tested with Angular 19 and 22; zone.js or zoneless) | The app's own `@angular/compiler-cli` compiles AOT (with template type-checking) in the node runtime; libraries are linked with the Angular Linker and bundled with esbuild-wasm (ADR 0008). Sass and Tailwind v4 work. No SSR, i18n or custom webpack. |
| `esbuild` | Vite apps (React, Vue, Svelte, Solid, Preact, Lit, vanilla), static sites with module scripts, and full-stack apps with a Node backend (`concurrently`, `client/` + `server/`) | Built in the browser with esbuild-wasm (ADR 0007) from dependencies installed with npm on the host. Vue SFCs, Svelte components, Solid JSX and Tailwind v4 are compiled with the app's own compilers (ADR 0011). A backend runs in the node runtime next to it; Vite's `/api` proxy and `http://localhost:<port>` calls reach it (ADR 0009). Other Vite plugins, PostCSS and Tailwind v3 are rejected as unsupported. |
| `node` | Next.js (real `next dev`, webpack, SWC wasm); real Vite 8 dev servers: SvelteKit, Astro, React Router (framework mode), Nuxt, SolidStart, and Vite apps with plugins the esbuild build does not apply; Node.js servers (`node server.js`) | Sandburg's own Node.js 24 runtime in a Web Worker (ADR 0006). SQLite (`better-sqlite3`, `sqlite3`, `node:sqlite`) runs on the official SQLite WebAssembly build (ADR 0009). WebSockets reach its servers (Next.js hot reloading, socket.io) and top-level await works (ADR 0010). `worker_threads`, `node:wasi`, `node` child processes and local sockets work; native packages with WebAssembly builds (rolldown, rollup, esbuild, Astro's compiler) use them (ADR 0012). Dependencies are installed with npm on the host, cached, and fetched lazily. No other programs (shells, npm) or synchronous child processes. |
| Docker reference | Vite, Next.js | `npm ci` or `npm install` plus the real dev server in `node:22-slim`. The same checks run in the same browser. |

## Fidelity

`sandburg compare` runs every project in the browser runtime and in the Docker
reference and pairs the results. The studies in
[`docs/fidelity`](docs/fidelity/README.md) cover 100 synthetic apps
(`scripts/corpus/`) across Vite + React, Next.js and vanilla Vite, with seeded
faults whose expected outcome is known. The first two measured almostnode
(removed in ADR 0013); the third measures `--runtime auto` against the
corpus's ground truth.

## Tests

```sh
npm test            # unit tests
npm run test:runtime # the node runtime's loader and built-ins, in Chromium
npm run test:e2e    # real Chromium; the first run needs network access to the allowlisted CDNs.
                    # Docker tests skip without Docker.
npm run typecheck
```

On networks that re-terminate TLS, Sandburg trusts the CAs in
`$SANDBURG_EXTRA_CA_CERTS` (or `$NODE_EXTRA_CA_CERTS`) in the browser too, by
pinning their public keys. Verification stays on.

## License

Apache-2.0.
