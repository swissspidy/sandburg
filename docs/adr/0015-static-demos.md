# ADR 0015: Static demos on GitHub Pages replay the host

- Status: Accepted
- Date: 2026-09-30

## Context

Sandburg's browser half needs a host: the orchestrator installs packages with npm, serves the
installed files, compiles modules for the runtime (native esbuild) and keeps caches. A public demo
should show the browser half, where the dev servers and apps run, without a server to operate.
GitHub Pages serves static files only and cannot set response headers. The runtime needs
cross-origin isolation (`SharedArrayBuffer`).

## Decision

**Record the host, replay it from static files.** `scripts/pages/build.ts` runs each demo project in
an ordinary Sandburg session, twice, and records every answer of the node adapter's `serve()`: the
runtime's worker, installed files, preload bundles, the Next.js seed cache, compiled modules. It also
records what `hostInstall()` returned. Answers are stored by content (`blobs/<sha256>.gz`), keyed by
request in `manifest.json`: the path for a GET, and the path, query and SHA-256 of the body for a POST.
Two runs keep both the first run's single-file requests and the second run's bundles and dev-server
caches.

**The demo page drives the same lifecycle as a run** (`mount`, `install` with the recorded install,
`start`, `ready`) through the same host bundle. Its service worker (`pages/sw.js`) sets hooks and then
imports the node runtime's own service worker (`src/adapters/node/sw.js`). The hooks do three things:

- They answer requests under `__sandburg/` from the manifest. Compiles are also keyed without their
  path, because Vite's config file has a timestamp in its name. The output depends on the path only
  through its loader (`.tsx`) and `.mjs`/`.mts`, and those stay in the key.
- They compile what was not recorded: code whose content changes from run to run (SvelteKit
  evaluates such code). The runtime's compiler (`compile.ts`) yields each esbuild transform it
  needs, so it runs synchronously on native esbuild on the host and asynchronously in the service
  worker, on esbuild's WebAssembly build of the same version. The WebAssembly loads on first use.
- They give the demo page COOP and COEP headers, so the page is cross-origin isolated after one reload
  on the first visit, and the replayed answers carry the same headers, so the runtime's workers are too.
- They put the app under the demo's path (`…/demos/<name>/app/`), which the worker controls, and
  inject a script that makes the app see itself at `/`. Links that would do a full navigation outside
  that path are sent back under it.

Two small hooks in the product make this possible: the page may name the runtime's base path
(`__sandburgBase`) and its service worker (`__sandburgServiceWorker`). A worker's script must be in
the service worker's scope for its requests to be answered.

The runtime also stops asking the host for its transform of a file under `node_modules` that is
not in the install (Vite writes its bundled config to `node_modules/.vite-temp/`): the answer was
always a 404.

**The build verifies itself.** `--verify` serves the site under `/sandburg/`, as GitHub Pages does,
loads every demo in Chromium behind the dead proxy that Sandburg runs use, and fails if an app does
not render or a request was not recorded. `.github/workflows/pages.yml` runs the build and the
verification on every push to `main`, then deploys.

## Consequences

- The demos run the real runtime, dev servers and apps in the visitor's browser. Only npm and the
  host's compiler are replayed.
- Installed files are what the recorded runs loaded. A code path they never took (a route the
  checks do not visit) can ask for an installed file that was not recorded, and the demo's terminal
  reports it. Compiles do not have this limit.
- Downloads are what a run fetches: 5–60 MB per demo, shared between demos by content.
- A full navigation that the page makes by assigning `location` (not a link) leaves the service worker's
  scope and fails.
