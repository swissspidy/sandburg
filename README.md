# Sandburg

Run and test generated web apps inside the browser.

Sandburg takes a generated web project, runs it in an in-browser runtime, and
checks it end to end in the same browser tab. It needs no container or microVM
per run. Think of it as WordPress Playground, generalized to JavaScript apps,
with WordPress itself as one of the runtimes.

- **One tab = one sandbox = one origin.** Many run in parallel in one browser.
- **Pluggable runtimes** behind one interface: almostnode (Vite, Next.js),
  WordPress Playground (plugins and themes), and optionally Nodebox.
- **Honest about fidelity:** `sandburg compare` runs the same apps in a Docker
  reference and reports how often the two agree, and why they disagree.
- **Nothing leaves the browser** except through a caching egress gateway with
  a per-runtime allowlist. Tests prove it.

## Status

| Milestone | State |
|---|---|
| 1. Vite + React spike | done ([ADR 0001](docs/adr/0001-runtime-adapters-serving-results.md)) |
| 2. Parallel batches, cache, network containment | done ([ADR 0002](docs/adr/0002-snapshots-and-batches.md)) |
| 3. Next.js on almostnode; Nodebox adapter | done ([ADR 0003](docs/adr/0003-nextjs-and-nodebox.md)) |
| 4. Fidelity study vs Docker | done ([ADR 0004](docs/adr/0004-docker-reference-and-fidelity-study.md), [report](docs/fidelity/almostnode-vs-docker.md)) |
| 5. WordPress Playground | done ([ADR 0005](docs/adr/0005-wordpress-playground.md)) |

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
sandburg run <project> [--runtime almostnode|wordpress|nodebox] [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                    # each subdirectory is a project
sandburg compare <dir> --reference docker [--report path]
sandburg snapshot <project>                            # store it, print its snapshot id
sandburg open <project>                                # load it in a visible tab
```

- `<project>` is a directory, a JSON file tree (`{ "path": "contents" }`), or
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

| Runtime | Runs | Notes |
|---|---|---|
| `almostnode` (default) | Vite, Next.js (App and Pages Router) | MIT. Dependencies load from esm.sh. Sandburg patches several gaps (ADR 0003). No Vite plugins or PostCSS, so Tailwind v4 does not apply. |
| `wordpress` | WordPress plugins and themes | WordPress Playground, loaded from playground.wordpress.net at run time. |
| `nodebox` | Next.js ≤ 13, in theory | Optional. You must install `@codesandbox/nodebox` yourself (Sustainable Use License). It emulates Node.js 16, so current stacks are rejected. |
| Docker reference | Vite, Next.js | `npm ci` or `npm install` plus the real dev server in `node:22-slim`. The same checks run in the same browser. |

## Fidelity

`sandburg compare` runs every project in the browser runtime and in the Docker
reference and pairs the results. The study in
[`docs/fidelity`](docs/fidelity/almostnode-vs-docker.md) covers 100 synthetic
apps (`scripts/corpus/`) across Vite + React, Next.js and vanilla Vite, with
seeded faults whose expected outcome is known.

## Tests

```sh
npm test            # unit tests
npm run test:e2e    # real Chromium; the first run needs network access to the allowlisted CDNs
npm run typecheck
```

## License

Apache-2.0. Runtimes loaded at run time keep their own licenses
(WordPress Playground: GPL-2.0-or-later; Nodebox: Sustainable Use License).
