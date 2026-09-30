# ADR 0001: Runtime adapter interface, serving and isolation model, result schema

- Status: Accepted (milestone 1); the almostnode adapter it describes was removed in [ADR 0013](0013-runtime-consolidation.md)
- Date: 2026-09-29

## Context

Sandburg takes a generated web project, runs it in an in-browser runtime, and
checks it end to end in the same browser. Several runtimes can do this, and
each has its own trade-offs: almostnode, Nodebox, WebContainers, a static
esbuild-wasm bundler, and later WordPress Playground. The orchestrator, the
checks and the fidelity analysis should not depend on which runtime runs a
given project. This ADR fixes three contracts that everything else builds on:

1. what a runtime adapter must implement,
2. how a sandbox is served to the browser and isolated from other sandboxes
   and from the network,
3. what a run produces (the result schema), including failure classification.

### What we learned from almostnode (the first adapter)

These findings came from reading almostnode 0.2.14 and shaped the decisions
below:

- Its "Vite" dev server is a light reimplementation, not Vite. It serves files
  from a virtual FS, transforms JSX/TS with esbuild-wasm, and turns CSS
  imports into JS. It does not read `vite.config.*`, run Vite plugins, or
  rewrite bare imports. Bare imports resolve only through an import map it
  injects, which pins React 18.2.0 no matter what `package.json` says.
- It loads esbuild-wasm, React and React Refresh from `esm.sh` and `unpkg.com`
  at run time. So "install" for a Vite app mostly means resolving versions for
  a CDN, not writing `node_modules`.
- Its service worker keeps a single `MessagePort` to one controlling page.
  Two runtimes on the same origin would take over each other's port.
- Its service worker forwards `/__virtual__/<port>/…` requests, plus other
  requests whose `Referer` is a virtual URL. A module loaded by an absolute
  path (`<script src="/src/main.tsx">`, the Vite default) has a non-virtual
  URL, so that module's relative imports would miss the dev server. Sandburg
  wraps the worker (see decision 2).
- It needs neither `SharedArrayBuffer` nor cross-origin isolation.

## Decision 1: Runtime adapter interface

An adapter has two halves, because the orchestrator runs in Node and the
runtime runs in the page.

**Node-side descriptor** (`src/types.ts`, type `AdapterDescriptor`; registered in `src/adapters.ts`), used by
the orchestrator before any browser work:

| Member | Purpose |
|---|---|
| `name`, `version` | Recorded in every result. |
| `browserEntry` | Module bundled into the host page. It exports `createAdapter()`. |
| `assets` | Static files the host origin must serve, for example a service worker at `/__sw__.js`. |
| `egress` | Origins the runtime itself needs, such as `https://esm.sh`. The network gateway allows only these, plus the project-level mirror. |
| `crossOriginIsolation` | Whether the host must send COOP/COEP (true for WebContainers, false for almostnode). |
| `bundleAliases` | Module aliases for bundling the browser half, such as a stub for `node:zlib`. |
| `probe(project)` | Static support check that returns `supported`, `unsupported` (with a reason) or `unknown`. An `unsupported` verdict ends the run as `runtime-unsupported` before a tab opens. |

**Browser-side adapter** (`src/host/types.ts`, type `RuntimeAdapter`), driven
by the host page over a small RPC:

```ts
interface RuntimeAdapter {
  readonly name: string;
  mount(files: FileTree, ctx: AdapterContext): Promise<void>;
  install(ctx: AdapterContext): Promise<InstallReport>;
  start(ctx: AdapterContext): Promise<{ url: string }>; // same-origin URL of the app
  ready?(ctx: AdapterContext): Promise<void>;           // runtime-level readiness, optional
  dispose(): Promise<void>;
}
```

Rules:

- Each step is idempotent in the sense that the orchestrator calls each one at
  most once, in order. Each step gets an `AbortSignal` from `ctx.signal`, and
  the orchestrator enforces the deadline from outside.
- "Build" does not get its own step. Dev-server runtimes build lazily on
  request, so build time is folded into `start` and `ready`. A runtime with an
  explicit build (the esbuild static adapter, or `next build` later) reports
  it in `InstallReport.buildMs` / the `start` step, and the result carries
  `timings.buildMs` when it is known and `null` otherwise.
- An adapter throws `AdapterError` with a `code` when it knows why it failed:
  `UNSUPPORTED` (the runtime cannot do this, such as a native module or a
  missing Node API), `APP` (the project is broken, such as a missing entry file
  or bad JSON), or `INTERNAL`. Classification uses the code first (decision 3).
- `InstallReport` states how dependencies were resolved (`lockfile`, `range` or
  `none`) and whether the lockfile was honored. The report says so honestly
  when a runtime cannot honor a lockfile.
- Readiness has two layers. The adapter's `ready()` says the runtime is up.
  The orchestrator then probes the app frame itself, adapter-agnostic: the
  frame loaded and the app rendered (`readySelector` if given, otherwise a
  non-empty `#root`/`#app`/`body`). A run is "ready" only when both pass.

The almostnode adapter implements `install` as dependency resolution into an
import map. It uses exact versions from `package-lock.json` when present and
`package.json` ranges otherwise. The map points every direct dependency at
`esm.sh`, with React externalized so there is one React instance. This replaces
almostnode's hard-coded React 18.2.0 map. The adapter does not populate
`node_modules`, because almostnode's Vite server would not use it.

## Decision 2: Serving and isolation model

- **One sandbox = one tab = one origin.** The host server listens on one
  loopback port and answers for `http://<sandboxId>.sandburg.localhost:<port>`.
  Chromium resolves `*.localhost` to loopback and treats it as a secure
  context, so service workers work without TLS. Each sandbox gets its own
  service worker registration, storage, cookies and SW message port. This is
  required for almostnode, where the SW keeps a single port, and it keeps
  parallel tabs independent without one port per sandbox.
- **Host page + app frame.** The tab loads the host page (Sandburg's runtime
  shell plus the adapter). The app is rendered in a full-size iframe at the URL
  that `start()` returns (for almostnode, `/__virtual__/<port>/`). The frame is
  same-origin with the host because the SW that serves it is per-origin.
  Checks run against the app frame. The frame is not a security boundary
  between the app and the runtime. The boundaries are the origin (between
  sandboxes), the browser process sandbox (to the machine) and the network
  gateway (to the outside).
- **Reserved paths.** On a sandbox origin the host owns `/`, `/__sandburg/*`
  and `/__sw__.js`, and the runtime owns everything else. Adapters may rely on
  this. almostnode's adapter serves a small worker prelude at `/__sw__.js`.
  The prelude forwards every other same-origin subresource request to the
  dev server, then `importScripts` almostnode's own worker.
- **COOP/COEP only on demand.** The host server sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` only when the adapter declares
  `crossOriginIsolation`. Turning it on for almostnode would break its CDN
  loads, which do not all send CORP headers. Where a runtime needs it and a
  CDN lacks CORP, the gateway can add `Cross-Origin-Resource-Policy:
  cross-origin` to cached responses.
- **Network: nothing leaves the browser directly.** Chromium is launched with
  its proxy set to an unroutable address, bypassing only
  `*.sandburg.localhost`. The bypass list must start with `<-loopback>`, or
  Chromium ignores the rule for `*.localhost`. With it, plain `127.0.0.1`
  also stays behind the dead proxy. On top of that, every request is intercepted at the browser context
  (`context.route`) by the egress gateway:
  - requests to the sandbox origin pass through to the host server,
  - requests to allowlisted origins (the adapter's `egress` plus the
    configured npm mirror) are served from a content-addressed disk cache and
    fetched upstream by Node on a miss. With `--offline`, a miss fails instead.
    Redirects are passed through and not followed, so ES module base URLs stay
    correct,
  - everything else is aborted and recorded in `network.blocked`.

  Any request that slips past interception reaches only the dead proxy. The
  cache makes runs repeatable: the same cache gives the same bytes. Milestone 2
  adds the test that proves blocking. The gateway is where a caching npm
  mirror plugs in, because it is only another allowlisted origin.

## Decision 3: Result schema (v1)

One JSON document per run, written to `<outDir>/<runId>/result.json`. The
schema is in `src/result-schema.json` and the types are in `src/types.ts`.
Additive changes keep `schemaVersion: 1`. A field removal or a change in
meaning bumps it.

```jsonc
{
  "schemaVersion": 1,
  "runId": "r-…",
  "status": "passed" | "failed" | "error",
  "project": { "name", "path", "framework", "snapshotId", "fileCount" },
  "runtime": { "name", "version" },
  "environment": { "sandburgVersion", "browser", "platform", "offline" },
  "startedAt", "finishedAt",
  "timings": { "probeMs", "loadMs", "mountMs", "installMs", "buildMs", "startMs", "readyMs", "checksMs", "totalMs" },
  "phases": [ { "name", "status": "ok" | "failed" | "timeout" | "skipped", "durationMs", "error"? } ],
  "install": { "resolution", "lockfileHonored", "dependencies" },
  "checks": [ { "id", "kind", "name", "status": "passed" | "failed" | "error" | "skipped",
                "blocking", "durationMs", "message"?, "details"? } ],
  "failure": null | { "class", "phase", "rule", "message", "evidence" },
  "console": [ { "source": "app" | "host", "type", "text", "url"? } ],
  "pageErrors": [ { "source", "message", "stack"? } ],
  "network": { "requests", "cacheHits", "cacheMisses", "failed": […], "blocked": […] },
  "artifacts": { "screenshot"?, "a11ySnapshot"? }
}
```

- `status`: `passed` when every blocking check passed, `failed` when the app
  ran but a blocking check failed, and `error` when the run did not reach the
  checks (probe, mount, install, start or ready failed or timed out).
- Check kinds: `functional` (user checks, blocking), `console` (uncaught app
  errors, blocking), `network` (failed app requests, informational), `axe`
  (informational until calibrated), `a11y-snapshot` and `screenshot`
  (artifacts). Per the goals, performance scores are not a quality signal and
  are not collected as checks.
- **Failure classification** is its own object because the fidelity study
  depends on it. `class` is one of `runtime-unsupported`, `app-bug`,
  `timeout`, `infra`, `unknown`. `rule` names the rule that fired, so a
  disagreement with the Docker reference can be traced to a rule and the rule
  fixed. Rules are checked in order and the first match wins (`src/classify.ts`):
  1. a phase deadline expired → `timeout`,
  2. an orchestrator or browser fault (crash, offline cache miss) → `infra`,
  3. `probe` returned unsupported → `runtime-unsupported`,
  4. an import of a package that `package.json` does not declare →
     `app-bug` (it would fail in any environment),
  5. `AdapterError` code `UNSUPPORTED` → `runtime-unsupported`, and code
     `APP` → `app-bug`,
  6. an error text that matches a known runtime-limitation signature (an
     unresolved bare specifier, a stubbed Node module, a native addon, a CDN
     transform failure) → `runtime-unsupported`,
  7. uncaught errors whose stack points into project sources, or a failed
     blocking check while the runtime phases succeeded → `app-bug`,
  8. anything else → `unknown`. We prefer an honest `unknown` to a guess.
     The fidelity study measures how large this bucket is.

  Because a timeout wins over every other rule, `ready` must not simply wait
  for its deadline. When the app throws an uncaught error and still has not
  rendered 2 s later, `ready` fails with that error. The run is then
  classified by its cause, not as a timeout.

## Milestone 1 measurements

These are from the fixture `fixtures/vite-react-counter` (React 18, a counter
and a todo list, two functional checks), headless Chromium 141.0.7390.37, and
one tab on a Linux x64 cloud container.

| | load | mount | install | start | ready | checks | total |
|---|---|---|---|---|---|---|---|
| cold cache (15 upstream fetches, 12 MB, mostly esbuild.wasm) | 0.51 s | 0.02 s | 0.00 s | 0.03 s | 6.25 s | 0.51 s | 7.4 s |
| warm cache, `--offline` | 0.51 s | 0.02 s | 0.00 s | 0.03 s | 1.44 s | 0.52 s | 2.6 s |

`ready` includes esbuild-wasm initialization and on-demand transforms. That
is where almostnode "builds".

## Consequences

- Adding a runtime means writing one descriptor and one browser module. The
  orchestrator, checks and results do not change.
- The origin-per-sandbox model scales to many tabs with one server. The cost
  is that hostnames must be valid DNS labels, so sandbox IDs are generated,
  never taken from user input.
- almostnode's fidelity for Vite is limited by design: no Vite config or
  plugins, and deps come from esm.sh rather than npm. The result records this
  (`install.resolution`, `runtime.version`), and milestone 4 measures it.
- User checks run in-process with Playwright's `expect` against the app frame,
  not through the `@playwright/test` runner. Running the full runner against
  an existing tab (via CDP) remains possible later without changing the
  schema.
- Node runs Sandburg's TypeScript directly (type stripping, Node >= 22.18). A
  compiled build for publishing to npm is future work.
