# Architecture

Sandburg runs a generated web app in a browser tab and tests it there. This page is the map: where
code runs, which module may import which, how the parts talk, and where to add things. The rules
are checked by `test/unit/architecture.test.ts` (`scripts/architecture.ts`), the lint rules
(`.oxlintrc.json`, `lint/sandburg-plugin.ts`) and the API report (`api/sandburg.api.md`); the
tables at the end are rewritten by `node scripts/architecture.ts --update`, and
`node scripts/architecture.ts` prints each module's layer and environments. The security
model is ADR 0001 and 0005; its boundaries are mapped in ADR 0054.

## One run

```
 Node.js (the host)                         Chromium: one context and origin per run (a sandbox)
 ───────────────────                        ─────────────────────────────────────────────────────
 Session.run (orchestrator/session.ts)  ──► host page /__sandburg/ (host/host.ts + the adapter's
   probe, install (npm --ignore-scripts,     browser half, adapters/node/browser.ts)
   adapters/node/install.ts),                  │ postMessage (node-runtime/messages.ts)
   mount, start, ready, checks                 ▼
 host server (orchestrator/host-server.ts) ◄─ runtime worker (node-runtime/worker.ts): Node's APIs,
   one server: every request's sandbox,        the app's dev server, its threads and child processes
   site and origin checked; the adapter's    service worker (adapters/node/sw.js): the app's
   routes (adapters/node/index.ts serve())     requests, to the page over a MessagePort
 file channel (orchestrator/host-socket.ts) ◄─ WebSocket from the runtime's helper (host-files.ts)
 egress gateway (orchestrator/egress*.ts)   ◄─ every request that leaves the sandbox
 checks (orchestrator/checks.ts, Playwright, or page-checks/ in the app's frame)
```

The phases are the orchestrator's; what they do for a runtime is the adapter's. The orchestrator
reaches an adapter only through its descriptor (`AdapterDescriptor` in types.ts, by name in
adapters.ts) on the host, and through the page's `RuntimeAdapter` (host/types.ts) in the browser.

## Environments

A module runs where its bundle runs. Each environment has entry points (below); a module is in
every environment a value import reaches it from. Code in a browser environment imports nothing of
Node's and no host-only package (esbuild, Playwright) except what its bundle stubs; type imports
are erased and allowed. A module may be in several (`node-runtime/names.ts` is in the host, the
runtime and the compile worker): it is then written for all of them.

Directories are close to environments, not the same: `adapters/node/` holds the adapter's host half
and its browser half (browser.ts, process.ts, browser-npm/, compile-worker.ts, sw.js, ws-shim.js);
`node-runtime/` holds the runtime and the host-side code that bundles it (bundle.ts,
bundle-cache.ts, bundle-dedupe.ts, runtime-module.ts). `node scripts/architecture.ts` says which
is which.

## Layers

What a directory may import (type imports too), top to bottom. A lower layer never imports a
higher one; the runtime imports no host code; the orchestrator imports adapters through their
registry, so a second adapter (ADR 0014: there is one, node) would need no orchestrator change.
`core` (src/'s own files: types.ts, framework.ts, project.ts, sources.ts, store.ts, …) imports no
other layer.

Value imports form no cycle. The one left (worker.ts and the modules split from it, which import
its state back) is listed in `KNOWN_CYCLES`; the test fails on a new one, and when the old one is
gone, so that the list only shrinks.

## Contracts between the parts

| between | over | defined in |
| --- | --- | --- |
| the package's users and Sandburg | `sandburg`'s exports | src/index.ts; checked: api/sandburg.api.md |
| a run's result and its readers | result.json | src/types.ts (`RunResult`), src/result-schema.json |
| the orchestrator and an adapter (host) | function calls | `AdapterDescriptor`, `HostRequest`, `HostResponse` (types.ts) |
| the orchestrator and the host page | Playwright's evaluate (RPC) | host/types.ts (`HostApi`, `RuntimeAdapter`) |
| the page and a runtime; a runtime and its threads | postMessage | node-runtime/messages.ts (`ToWorker`, `FromWorker`, `ToParent`) |
| the service worker and the page | a MessagePort | adapters/sw-bridge.ts (`BridgedRequest`, `BridgeReply`) |
| a runtime and the host | HTTP under /__sandburg/ | the adapter's `serve()` (adapters/node/index.ts) |
| a runtime's helper and the host | the file channel (WebSocket) | host-socket.ts and host-files.ts |
| the host and the app's frame | the page checks | page-checks/types.ts |

The messages are typed, not validated: they come from Sandburg's own code (an app cannot post
them, ADR 0047). What an app controls (a stack, an exit code, a URL, a body) is coerced or bounded
where it is read.

## Where to add things

- **A framework**: an entry in `FRAMEWORKS` (src/framework.ts): how to detect it (the table's
  order is detection's: frameworks built on Vite before `vite`), its build and cache directories,
  its dev caches kept between runs, its telemetry switches, how the node runtime starts its dev
  server (spares at mount, environment, dev command options) and how the Docker reference does.
  Its name goes in the `Framework` union (types.ts: the table is a Record over it, so one without
  the other does not compile) and in result-schema.json (test/unit/frameworks.test.ts). What it
  needs of its packages goes by package, since frameworks share them: source patches and
  WebAssembly builds in adapters/node/install-rules.ts, deferred imports in deferred-imports.ts.
  Signals in the page that are not keyed by framework stay where they are read: hydration markers
  (host/settle.ts), loading pages (orchestrator/app-ready.ts), error formats (classify.ts). Next.js
  and static sites have flows of their own in the node adapter (an entry script instead of the dev
  script, seeds): adapters/node/index.ts, plan.ts, seeds.ts and browser.ts.
- **A route on the host**: in the adapter's `serve()`, behind the host server's checks (the
  `sandburg/one-host-server` lint rule refuses a server of its own). A route a runtime reaches
  over the file channel is also in host-socket.ts's SERVED or POSTED.
- **A Node.js built-in**: node-runtime/builtins/ (registered in builtins.ts); a large dependency
  as a runtime library (node-runtime/libs.ts) loaded on first use.
- **A cache on the host**: keyed by digests (the `sandburg/cache-key-digest` lint rule), never by
  a name an app controls.
- **A browser module**: add nothing to the lint config by hand; the test names a browser module
  `.oxlintrc.json` misses, and a host one it lists.

## The map

<!-- architecture:begin (generated by node scripts/architecture.ts --update) -->

| layer | paths | what | may import |
| --- | --- | --- | --- |
| api | `src/index.ts`, `src/cli.ts` | the package's exports and the CLI | compare, reference, orchestrator, adapters-registry, page-checks, core |
| compare | `src/compare/` | comparisons with the Docker reference | reference, orchestrator, core |
| reference | `src/reference/` | the Docker reference runtime | orchestrator, adapters, host, core |
| orchestrator | `src/orchestrator/` | the session, Chromium, the host server, egress, checks | adapters-registry, page-checks, host, core |
| adapters-registry | `src/adapters.ts` | the adapters by name | adapters, core |
| adapters | `src/adapters/` | an adapter's host and browser halves (the node adapter) | host, node-runtime, core |
| page-checks | `src/page-checks/` | the checks API, its compiler and its in-frame runtime | core |
| host | `src/host/` | the host page (RPC from the orchestrator, the adapter's browser half) | core |
| node-runtime | `src/node-runtime/` | the runtime, and the host-side code that bundles it | core |
| core | `src/` | types and helpers every layer shares | — |

| environment | entries | what |
| --- | --- | --- |
| host | `index.ts`, `cli.ts` | Node.js: the session, the host server, installs, compiles, caches |
| page | `host/host.ts`, `adapters/node/browser.ts` | the host page in a sandbox tab (one per run): the adapter's browser half |
| runtime | `node-runtime/worker.ts`, `node-runtime/globals-shim.ts`, `node-runtime/lib-globals.js`, `node-runtime/process-alias.cjs`, `node-runtime/url-querystring.cjs` | a Node.js runtime's Web Worker (and its threads and child processes) |
| compile-worker | `adapters/node/compile-worker.ts` | the page's compiler on esbuild-wasm (stubs `node:crypto`, `esbuild`) |
| service-worker | `adapters/node/sw.js` | the sandbox origin's service worker |
| app-frame | `page-checks/runtime.ts`, `page-checks/dom-shim.ts`, `adapters/node/ws-shim.js` | the app's frame: the page checks' runtime and the WebSocket shim |

<!-- architecture:end -->
