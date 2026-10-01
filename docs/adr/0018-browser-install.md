# ADR 0018: npm install in the browser (opt-in)

- Status: Accepted
- Date: 2026-10-01

## Context

Until now the host installed every project's packages with npm and served `node_modules` to the
page. That suits batches: installs are cached on disk and shared across runs. But it ties a run to
a Node.js host with npm. If the page can install packages itself, an app that is generated in the
browser, by an LLM for example, can be installed and previewed there too. The only host it needs
then is one that serves the page.

The npm registry answers cross-origin requests (`access-control-allow-origin: *`) for package
documents and tarballs, and browsers have what an install needs: `fetch`, `DecompressionStream`
for gzip and WebCrypto for the integrity checks.

## Decision

`--install-in browser` (library: `installIn: 'browser'`) makes the page do the install. The host
default stays the same.

- **Resolution** ([`src/node-runtime/npm/resolve.ts`](../../src/node-runtime/npm/resolve.ts)) follows
  npm. A `package-lock.json` (v2/v3) is installed exactly as it is written. Without one, each range
  resolves to the `latest` tag if that satisfies it, otherwise to the newest version that does. A
  package goes to the top of `node_modules` if that place is free, otherwise into its dependent's
  `node_modules`; one that a parent already provides in a matching version is shared. Peer
  dependencies are installed from where their dependent is installed, never inside it. A visible
  copy is used even if it does not match, as `npm --legacy-peer-deps` would. This keeps packages
  that must share a peer on one copy (emnapi's runtime and the bindings built against it).
  Optional and bundled dependencies are left out, as the host install leaves them out.
- **Fetching** ([`registry.ts`](../../src/node-runtime/npm/registry.ts)) uses abbreviated package
  documents, 16 tarballs at a time, each checked against its sha512 integrity before it is gunzipped
  and unpacked ([`tar.ts`](../../src/node-runtime/npm/tar.ts)). Tar paths are normalized: some
  packages are packed with `./` inside paths, which would otherwise create a directory that lists
  itself.
- **The same changes as the host install**
  ([`install-rules.ts`](../../src/adapters/node/install-rules.ts), shared by both): WebAssembly
  bindings for napi-rs packages, WebAssembly builds in place of native code, SWC's WebAssembly build
  for Next.js, source patches, and the index of package binaries.
- **Memory:** `node_modules` becomes one `SharedArrayBuffer` and an index of paths
  ([`install.ts`](../../src/node-runtime/npm/install.ts)). The runtime and every thread and child
  process it starts read files from it without copying, and without asking another thread, which may
  be blocked. Identical files are stored once (SWC's WebAssembly build is at two paths).
- **Errors are worded as npm words them**, so they classify the same way: a missing package or
  version is an `app-bug` (`unresolvable-dependency`). Dependencies that are not on a registry (git,
  files, links, URLs, workspaces) are `runtime-unsupported`.

Requests to the registry go through the run's network gateway like any other request, so the
allowlist and the HTTP cache apply to them.

## Results

All 17 fixtures pass with `--install-in browser`, on the latest framework versions
([ADR 0019](0019-latest-versions.md)), with a warm HTTP cache:

| Fixture | Install | Start | Total |
|---|---|---|---|
| angular-tasks | 5.2 s | 18.0 s | 27.7 s |
| angular-zone | 8.7 s | 21.7 s | 34.5 s |
| astro-app | 3.4 s | 20.1 s | 35.2 s |
| lit-vite | 1.7 s | 4.4 s | 8.1 s |
| next-app-router | 4.8 s | 8.2 s | 25.6 s |
| node-express | 0.9 s | 0.7 s | 2.3 s |
| nuxt-app | 6.0 s | 5.8 s | 35.1 s |
| preact-vite | 2.4 s | 5.2 s | 9.8 s |
| react-express-split | 3.6 s | 8.9 s | 15.0 s |
| react-router-app | 3.5 s | 11.4 s | 18.6 s |
| solid-start-app | 2.6 s | 6.7 s | 22.4 s |
| solid-vite | 2.5 s | 5.8 s | 10.1 s |
| svelte-vite | 2.0 s | 12.4 s | 16.4 s |
| sveltekit-app | 2.1 s | 15.6 s | 24.3 s |
| vite-react-counter | 1.9 s | 4.7 s | 8.8 s |
| vite-socketio-chat | 2.5 s | 8.2 s | 11.8 s |
| vue-express-sqlite | 2.6 s | 9.5 s | 14.0 s |

The install takes a few seconds once the HTTP cache has the tarballs. Starting the dev server takes
longer than with a host install, because installed packages are not compiled ahead of time. The
runtime compiles each ESM file (or file that needs lowering) when it loads it, through the host's
compile endpoint, and without the host install's preload of files it knows a stack will need.

## Consequences

- An app can now be installed and run without npm on the host. Only one host service is still
  needed: the compile endpoint (native esbuild). Compiling in the page with esbuild-wasm is the next
  step toward a run that needs nothing from its host but static files.
- Installs in the browser are not cached across runs, except for the HTTP cache of the requests.
- Not supported: workspaces and `link:`/`file:` dependencies, git and URL dependencies, install
  scripts (the host install does not run them either), and `overrides` beyond plain
  `"name": "version"` entries.
