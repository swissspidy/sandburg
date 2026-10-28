# The library

Everything the CLI does is in the package's library. The full public API, with every type, is in
[`api/sandburg.api.md`](../../api/sandburg.api.md) (generated from the declarations, and compared by the
unit tests).

```ts
import { Session, dockerReference } from 'sandburg';

const session = new Session();
await session.open();
const result = await session.run('./project', { checks: './checks.spec.ts' });
const reference = await session.run('./project', { nodeRuntime: dockerReference(), checks: './checks.spec.ts' });
await session.close();
```

## Session

A `Session` is a browser and the host's services (the host server, the egress gateway, caches) that
runs project after project, each in its own browser context and origin. `open()` it, `run()` projects
(side by side if you like: `runBatch` does), `close()` it.

| Member | What it does |
|---|---|
| `new Session(options?)` | See [SessionOptions](#sessionoptions). |
| `open()` | Starts the browser and the host's services. Fails with what to change when Chromium is missing or its sandbox cannot start ([Troubleshooting](troubleshooting.md)). |
| `run(project, options?)` | Runs one project: a path (directory, `.zip`, JSON file tree, `snapshot:<id>`) or a `Project` (`loadProject`, `projectFromFiles`). Resolves to its [`RunResult`](#resultjson). |
| `prewarm(options?)` | Runs the runtime's warm-up projects whose installs are missing, side by side, and returns their names. On a warm machine it only checks. |
| `close()` | Closes the browser and the services. |
| `store` | The session's `SnapshotStore`. |
| `browserSandbox` | Whether Chromium runs inside its OS sandbox. |

`runProject(project, options)` opens a session, runs one project and closes it.

### SessionOptions

| Option | Default | What it does |
|---|---|---|
| `cacheDir` | `.sandburg/cache` | Directory for the HTTP cache. |
| `storeDir` | `.sandburg/store` | Directory of the snapshot store. |
| `codeCacheDir` | `.sandburg/code-cache` | Directory for V8's compiled code of the host's own scripts, or `null` for none on disk. |
| `offline` | `false` | Fail on cache misses instead of fetching upstream. |
| `headless` | `true` | |
| `executablePath` | Playwright's, or `$SANDBURG_CHROMIUM` | Chromium binary. |
| `browserSandbox` | `true`, unless `$SANDBURG_NO_BROWSER_SANDBOX` is `1` | Run Chromium inside its OS sandbox. Where it cannot start, `open()` fails and says so; there is no fallback ([Security](security.md)). |
| `extraCaCerts` | `$SANDBURG_EXTRA_CA_CERTS`, then `$NODE_EXTRA_CA_CERTS` | PEM bundle of extra CAs the browser accepts for tunneled HTTPS. |
| `spareTab` | `true` | Keep a tab ready for the next run (its context, egress routes and host page set up, its runtime loaded). |

## RunOptions

| Option | Default | What it does |
|---|---|---|
| `runtime` | `node` | In-browser runtime adapter name (`adapterNames`). Ignored when `nodeRuntime` is set. |
| `nodeRuntime` | | Run in an out-of-browser runtime instead, e.g. `dockerReference()`; called once per run. |
| `checks` | | A checks file's path, a `Checks` object, or a file loaded with `loadPageChecks` ([Writing checks](writing-checks.md)). |
| `checksIn` | `'host'` | Where a checks file (a path in `checks`) runs: `'host'` (imported) or `'page'` (in the sandbox tab, [ADR 0023](../adr/0023-checks-in-the-page.md)). |
| `outDir` | `.sandburg/runs` | Results go to `<outDir>/<runId>/`. |
| `readySelector` | | CSS selector that must match a rendered element before checks start. |
| `failFastChecks` | `true` | A failing assertion stops waiting once the app is idle, after at least 5 s ([ADR 0016](../adr/0016-faster-batches.md)). `false`: every assertion waits its whole timeout. |
| `timeouts` | `DEFAULT_TIMEOUTS` | Per phase, per check (`check`) and per assertion (`expect`), in ms. See [below](#timeouts). |
| `infraRetries` | `1` | Re-run a project whose run failed as `infra` (a flaky download, a crashed tab) this many times. The result lists the earlier attempts' run ids in `previousAttempts`. |
| `hold` | `false` | Keep the tab open after the run until it is closed (`sandburg open`), also when a phase before the checks failed. |
| `installIn` | `'host'` | `'host'` (npm on the host) or `'browser'` (opt-in: the page installs from the npm registry, [ADR 0018](../adr/0018-browser-install.md)). |
| `collectFiles` | | After the checks, the app's files whose path matches this pattern (a RegExp source) go to `onAppFiles` (`--save-files` on the CLI). In-browser runtimes only; only relative paths outside `node_modules`, dot directories and `.git`; over 1000 files or 256 MB, none, and `refused` says why. An invalid pattern fails `run()` before the run starts. |
| `onAppFiles(files, refused?)` | | Receives what `collectFiles` collected. |
| `onPhase(phase)` | | Called as each lifecycle phase of the run starts. |
| `onRenderer(renderer)` | | Called once the run has its tab, with its renderer's memory (`RunRenderer`). |
| `onSeed()` | | Called when the run starts a seed run beside it (a cold Next.js install's, [ADR 0037](../adr/0037-nextjs-runs.md)); returns that run's `onPhase` and `onRenderer`, and `ended()`. |

### Timeouts

A run goes through these phases: `probe`, `load`, `mount`, `install`, `start`, `ready`, `checks`,
`dispose`. `DEFAULT_TIMEOUTS`, in ms:

| `probe` | `load` | `mount` | `install` | `start` | `ready` | `checks` | `check` | `expect` | `dispose` |
|---|---|---|---|---|---|---|---|---|---|
| 5 000 | 30 000 | 30 000 | 60 000 | 60 000 | 90 000 | 180 000 | 30 000 | 5 000 | 10 000 |

A runtime raises some of them, and `timeouts` in `RunOptions` overrides both. The node runtime (the
default) uses `install` 600 000, `start` 180 000, `ready` 240 000, `check` 60 000, `expect` 20 000 and
`dispose` 60 000 (a cold Next.js install and its first compile take a while;
[`src/adapters/node/index.ts`](../../src/adapters/node/index.ts)). The Docker reference raises `mount`
(the image pull) and `dispose`.

```ts
await session.run('./project', { checks: './checks.spec.ts', timeouts: { check: 60_000, checks: 300_000 } });
```

What happens when a check or the checks phase runs out of time is in
[Writing checks](writing-checks.md#time-limits).

## Batches and comparisons

```ts
import { Session, discoverProjects, runBatch, compare, renderReport, dockerReference } from 'sandburg';

const session = new Session();
await session.open();
const items = await discoverProjects('./apps');                 // as `sandburg batch` finds them
const { summary, results } = await runBatch(session, items, { parallel: 4 });
await session.close();
```

`runBatch` takes `RunOptions` and `parallel`, `prewarm`, `batchDir`, `onResult` and `log`, and
returns the `BatchSummary` it writes to `summary.json` with every `RunResult`. `compare` runs the same
items in a reference runtime too (`reference: { name, factory }`) and returns a `CompareReport`, which
`renderReport` turns into Markdown.

## result.json

Each run writes to `.sandburg/runs/<runId>/` (`outDir`):

- `result.json`: the `RunResult` ([schema](../../src/result-schema.json), `schemaVersion: 1`);
- `screenshot.png` and `a11y.yaml`: the screenshot and the accessibility tree;
- the runtime's log, when there is one (`artifacts.runtimeLog`).

The fields an agent or a CI job reads first:

| Field | What it is |
|---|---|
| `status` | `passed`, `failed` (the app ran, a blocking check failed) or `error` (the run did not reach the checks, or they did not finish in time). |
| `failure` | `null`, or `{ class, phase, rule, message, evidence }`: [why it failed](#failure-classes). |
| `checks[]` | Every check: `id`, `kind`, `name`, `status` (`passed`, `failed`, `error`, `skipped`), `blocking`, `durationMs`, `message`. |
| `phases[]` | Each phase's `status` (`ok`, `failed`, `timeout`, `skipped`), `durationMs` and `error`. |
| `pageErrors[]`, `console[]` | The app's uncaught errors and console output, by `source` (`app` or `host`). |
| `network` | Requests, cache hits and misses, and the `failed` and `blocked` ones (URL, method, reason). |
| `timings` | `probeMs` … `checksMs`, `totalMs`. |
| `project` | `name`, `path`, `framework`, `snapshotId`, `fileCount`. |
| `install` | How dependencies were resolved (`lockfile`, `range`, `none`) and their versions. |
| `environment` | `sandburgVersion`, `browser`, `browserSandbox`, `platform`, `offline`. |
| `artifacts` | Paths of the screenshot, the accessibility tree and the runtime log. |

## Failure classes

Every failure has a class and names the rule that decided it ([`src/classify.ts`](../../src/classify.ts)).
Rules run in order and the first match wins. App bugs point at the file and line where the dev server
reported them.

| Class | Means | Rules |
|---|---|---|
| `app-bug` | The app is wrong; it would fail the same way anywhere. | `blocking-check-failed`, `compile-error`, `undeclared-import`, `unresolvable-dependency`, `app-error-before-ready`, `adapter-code:APP`, `project-load` (a project that is there but does not load) |
| `runtime-unsupported` | The app needs something the in-browser runtime does not do. | `probe-unsupported`, `adapter-code:UNSUPPORTED`, `signature:*` (`bare-specifier`, `native-addon`, `stubbed-builtin`, `missing-builtin`, `node-version`, `esbuild-wasm`, `runtime-worker`, `wasm-thread-crash`, `wasm-trap`) |
| `timeout` | A phase ran out of time with no better explanation. | `phase-deadline` |
| `infra` | Sandburg's own machinery or the network failed (retried `infraRetries` times). | `runtime-boot-fetch`, `signature:download-failed`, `infra-error` |
| `unknown` | Nothing matched. | `unmatched`, `checks-load` (the checks file did not load), `project-load` (the project is not there) |

How to act on each is in [Troubleshooting](troubleshooting.md#reading-a-failure) and
[Agents and CI](agents-and-ci.md#interpreting-results). `classify(input)` is exported, to classify
your own runs the same way.
