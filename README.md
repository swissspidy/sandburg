# Sandburg

Run and test generated web apps inside the browser.

Sandburg takes a generated web project, runs it in an in-browser runtime, and
checks it end to end in the same browser tab. It needs no container or microVM
per run. Think of it as WordPress Playground, generalized to JavaScript apps.

**Status: milestone 1 (spike).** A Vite + React app runs in
[almostnode](https://github.com/macaly/almostnode) inside a Playwright-driven
Chromium tab. Its functional checks pass, and each run records its timings.
For the design, see [ADR 0001](docs/adr/0001-runtime-adapters-serving-results.md).

## Try it

Requires Node.js 22.18 or later, which runs the TypeScript sources directly.
It also needs a Chromium that Playwright 1.56 can launch.

```sh
npm install
npx playwright install chromium   # or set SANDBURG_CHROMIUM=/path/to/chrome
npm run spike
```

```
PASSED  vite-react-counter (vite) on almostnode 0.2.14
  timings  load 0.51s  mount 0.02s  install 0.00s  start 0.03s  ready 1.44s  checks 0.52s  total 2.56s
  network  17 requests, cache 15 hit / 0 miss, 0 blocked, 0 failed
  ok   Screenshot
  ok   Accessibility tree snapshot
  ok   axe-core accessibility scan
  ok   counter increments on click
  ok   todo can be added and completed
  ok   No uncaught errors in the app
  ok   No failed or blocked requests
  result   .sandburg/runs/r-…/result.json
```

## CLI

```sh
sandburg run <project> [--runtime almostnode] [--checks checks.spec.ts] [--offline] [--json]
```

- `<project>` is a directory or a JSON file tree (`{ "path": "contents" }`).
- `--checks` is a module whose default export maps check names to functions.
  Each function gets the app frame and Playwright's `expect`:

  ```ts
  import type { Checks } from 'sandburg';

  export default {
    'counter increments on click': async ({ app, expect }) => {
      await app.getByRole('button', { name: /count is/ }).click();
      await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1');
    },
  } satisfies Checks;
  ```
- `--offline` answers every request from the HTTP cache
  (`.sandburg/cache`) and fails on a miss.
- Exit codes: `0` passed, `1` failed (the app ran but a blocking check
  failed), `2` error (the run did not reach the checks).

`sandburg batch` and `sandburg compare` are planned for milestones 2 and 4.

## Library

```ts
import { Session } from 'sandburg';

const session = new Session({ offline: false });
await session.open();
const result = await session.run('./project', { checks: './checks.spec.ts' });
await session.close();
```

Each run writes `result.json` (schema:
[`src/result-schema.json`](src/result-schema.json)), `screenshot.png` and
`a11y.yaml` to `.sandburg/runs/<runId>/`. Each failure is classified as
`runtime-unsupported`, `app-bug`, `timeout`, `infra` or `unknown`, and names
the rule that decided it.

## How it works

- **One sandbox = one tab = one origin**, `http://<runId>.sandburg.localhost:<port>`.
  The origin serves a host page that bundles the runtime adapter. The app
  renders in an iframe that the runtime's service worker serves.
- **Nothing leaves the browser directly.** Chromium's proxy points at an
  unroutable address. Every request goes through an egress gateway, which
  serves allowlisted origins (for almostnode, `esm.sh` and `unpkg.com`) from
  a content-addressed disk cache and blocks everything else.
- **Checks run in the same tab:** your functional checks, uncaught errors,
  failed or blocked requests, axe-core, an accessibility-tree snapshot and a
  screenshot. axe and network results are informational until calibrated.

## Known limitations of the almostnode adapter

- almostnode's "Vite" is a reimplementation. It does not read
  `vite.config.*` or run Vite plugins.
- Dependencies load from esm.sh through an import map that Sandburg
  generates. The map uses exact versions from `package-lock.json` when
  present, and `package.json` ranges otherwise. `node_modules` is not
  populated.
- Only Vite projects are accepted. Next.js support is planned for
  milestone 3.

## Tests

```sh
npm test            # unit tests
npm run test:e2e    # real Chromium + almostnode; the first run needs network access to esm.sh and unpkg.com
npm run typecheck
```

## License

Apache-2.0
