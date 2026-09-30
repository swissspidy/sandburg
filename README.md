# Sandburg

Run and test generated web apps inside the browser.

Sandburg takes a generated web project, runs it in an in-browser runtime, and
checks it end to end in the same browser tab. It needs no container or microVM
per run. Think of it as WordPress Playground, generalized to JavaScript apps.

- **One tab = one sandbox = one origin.** Many run in parallel in one browser.
- **One runtime, the project's own tools:** Sandburg's own Node.js 24 runtime
  runs the project's dev script as written: `next dev`, Vite (React, Vue,
  Svelte, Solid, Preact, Lit, Tailwind; SvelteKit, Astro, Nuxt, React Router,
  SolidStart), `ng serve`, Express, `concurrently` with a front end and an
  API, SQLite via WebAssembly.
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
| 7. esbuild-wasm adapter for Vite-style apps | done, since removed ([ADR 0007](docs/adr/0007-esbuild-adapter.md), [ADR 0014](docs/adr/0014-node-runtime-only.md)) |
| 8. Angular | done ([ADR 0008](docs/adr/0008-angular.md); `ng serve` since [ADR 0014](docs/adr/0014-node-runtime-only.md)) |
| 9. Full-stack apps (front end + Express), Vue, SQLite | done ([ADR 0009](docs/adr/0009-full-stack-vue-sqlite.md)) |
| 10. WebSockets and hot reloading; top-level await | done ([ADR 0010](docs/adr/0010-websockets-and-top-level-await.md)) |
| 11. Svelte, Solid, Preact, Lit | done ([ADR 0011](docs/adr/0011-client-frameworks.md); on real Vite since [ADR 0014](docs/adr/0014-node-runtime-only.md)) |
| 12. Real Vite: SvelteKit, Astro, React Router, Nuxt, SolidStart | done ([ADR 0012](docs/adr/0012-real-vite-and-meta-frameworks.md)) |
| 13. One Node.js runtime; `--runtime auto`; almostnode and Nodebox removed | done ([ADR 0013](docs/adr/0013-runtime-consolidation.md)) |
| 14. Everything on the node runtime: dev scripts through a shell, `ng serve`; esbuild and angular adapters removed | done ([ADR 0014](docs/adr/0014-node-runtime-only.md)) |

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
sandburg run <project> [--checks checks.spec.ts]
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

## Runtime

Every project runs on Sandburg's Node.js 24 runtime in a Web Worker (ADRs 0006, 0014). It installs
the project's dependencies with npm on the host (`--ignore-scripts`; cached, fetched lazily; every
package of a project, such as `client/` and `server/`) and runs the project's dev script, or `start`,
as `npm run dev` would.

| What | How |
|---|---|
| Dev scripts | A small shell runs them: `&&`, `\|\|`, `;`, `&`, `cd`, `VAR=value`, `cross-env`, npm/pnpm/yarn scripts (`--prefix`), package binaries, `concurrently`, `npm-run-all`. `tsx`, `ts-node` and `nodemon` run their file with the runtime's TypeScript support. Only Node programs exist: anything else (`git`, `python`, `docker`) exits with 127. |
| Front ends | Vite 5 to 8 with its plugins (React, Vue, Svelte, Solid, Preact, Lit, Tailwind), SvelteKit, Astro, React Router, Nuxt, SolidStart (ADR 0012); `next dev` with webpack and SWC's WebAssembly build; `ng serve` (Angular 19 and 22). A static site without a package.json is served as files. |
| Back ends | Express and other Node servers, next to the front end (Vite's `/api` proxy, `http://localhost:<port>` from the page, WebSockets through the proxy or direct); SQLite (`better-sqlite3`, `sqlite3`, `node:sqlite`) on the official WebAssembly build (ADR 0009). |
| Node APIs | `worker_threads`, `child_process` (Node programs), `node:wasi`, local sockets, top-level await, WebSockets (ADRs 0010, 0012). Native packages with WebAssembly builds use them (rolldown, rollup, esbuild, lightningcss, Tailwind's oxide, Astro's compiler). No synchronous child processes and no native addons without a WebAssembly build. |
| Docker reference | Vite and Next.js apps: `npm ci` or `npm install` plus the real dev server in `node:22-slim`; the same checks in the same browser. |

The page is the server that answers `/` with HTML; a crash of one of the dev script's servers
while the rest comes up is an app bug. Installed files that earlier runs loaded arrive as one bundle, and Vite's pre-bundled dependencies are kept between runs of
projects that import the same packages.

## Fidelity

`sandburg compare` runs every project in the browser runtime and in the Docker
reference and pairs the results. The studies in
[`docs/fidelity`](docs/fidelity/README.md) cover 100 synthetic apps
(`scripts/corpus/`) across Vite + React, Next.js and vanilla Vite, with seeded
faults whose expected outcome is known. The first two measured almostnode
(removed in ADR 0013); the third measures `--runtime auto` (ADR 0013, since
replaced by the node runtime alone) against the corpus's ground truth.

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
