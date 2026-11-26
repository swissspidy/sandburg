# ADR 0074: The browser runtime as a subpath export; Playwright an optional peer dependency

- Status: Accepted
- Date: 2026-11-25

## Context

Issue [#167](https://github.com/swissspidy/sandburg/issues/167): a tool that embeds Sandburg's
in-browser Node.js runtime (a local preview server, a benchmark page) had to install `sandburg`, which
pulled in `playwright-core` and `@playwright/test`. It then reached into unexported modules
(`orchestrator/host-server`, `adapters/node/index`, `adapters/node/compile-wasm-bundle`,
`node-runtime/bundle`, `node-runtime/libs`, `adapters/node/browser-npm/install`) and ran esbuild itself
to write `host.js`, `compile.js`, `sw-core.js`, `frame-guard.js`, `isolation.js`, `esbuild.wasm`,
`sqlite3.wasm` and `runtime/*`.

Those are the files the demo site's generator page (ADR 0021) runs from. That page needs no Sandburg
host: packages install from the npm registry in the page, modules compile in the page on
esbuild-wasm, and its service worker (`pages/sw.js`) serves the runtime's own files. Sandburg built
them only in `scripts/pages/build.ts`, and bundled the rest of the browser side on request from `src/`
(ADR 0022).

The issue's second part, a preview served to the user's own browser, builds on this one and is left
for later.

## Decision

**The package ships the browser runtime prebuilt, as `sandburg/browser-runtime`.**

- `npm run build` (and so `npm pack`) runs `scripts/browser-runtime.ts`, which writes
  `dist/browser-runtime/`. The demo site's build writes the same files with the same code, so the
  site's generator is a test of what the package ships.
- `package.json` exports `./browser-runtime` (its `index.js`, with declarations) and
  `./browser-runtime/*` (the directory's files), so an embedder finds the directory with
  `import.meta.resolve('sandburg/browser-runtime/sw.js')` and serves it as static files.
- **The directory**: `index.js` (the API, bundled for the browser), `sw.js` (the embedder's service
  worker), `sw-core.js` (the node runtime's service worker, which `sw.js` imports), `compile.js`
  (the service worker's compiler on esbuild-wasm), `host.js` (the host page's script,
  `window.__sandburg`), `frame-guard.js` and `isolation.js`, and `runtime/` (the runtime's worker and
  libraries, the page's compile and install workers, SQLite, the WebSocket shim, and esbuild's and
  SQLite's WebAssembly). The service workers load `runtime/esbuild.wasm`; the site no longer keeps a
  second copy at its root.
- **The API** (`src/browser-runtime/index.ts`): `isolate()` registers the service worker and reloads
  the page once, for cross-origin isolation; `loadHost()` loads `host.js` and returns the `HostApi`;
  `startProject()` mounts, installs (`pageInstall`), starts and loads the app, as a Sandburg run and
  the generator do; `appPath()`, `guardAppFrame()`, `isolationFailure()`, `detectFramework()` and
  `pageInstall()` are exported for pages that drive the host themselves. The page needs an
  `<iframe id="app">`.
- **The service worker** (`src/browser-runtime/sw.js`) is `pages/sw.js` without the recorded answers:
  it serves `runtime/`, compiles what the host would compile, answers the dev-cache upload and the
  runtime's notes as the site does, and makes the embedding page and the app cross-origin isolated.
  Its query string says where the app lives (`app`, default `<scope>app`) and which paths under the
  scope are the embedder's own files (`pass`, besides its own directory); other paths are the app's.
  A scope above the runtime's directory needs the `Service-Worker-Allowed` header on `sw.js`.

**Playwright is an optional peer dependency.** `playwright-core` and `@playwright/test` move from
`dependencies` to `peerDependencies`, at the exact version Sandburg is developed with (also in
`devDependencies`), with `peerDependenciesMeta` marking them optional. A required peer would not do:
npm 7 and later install required peers, so every embedder would still download Playwright. So:

- The CLI and the library need them installed beside `sandburg`. When they are not, `sandburg` stops
  (exit code `2`) and prints the `npm install` command with the versions.
- Exact versions: a Playwright version fixes its Chromium build (1.65.0 drove 158, 1.65.1 drives 159),
  which Sandburg's launch flags, its missing-browser message and its tests are written for. A unit
  test fails when the peer and development versions differ, so a Dependabot update of one cannot
  leave the other behind.

## Consequences

- Embedders install `sandburg` without Playwright and serve one directory; they no longer import
  internal modules or run esbuild. The API and the service worker's query are now public, and
  changing them is a breaking change.
- The package grows from 2.9 MB to 21.3 MB unpacked (5.8 MB packed), most of it esbuild's
  WebAssembly binary (14 MB), which the `esbuild-wasm` dependency also holds: an export cannot point
  outside the package, and a static directory cannot follow a symlink everywhere.
- Users of the CLI and the library install two more packages: `npm install --save-dev sandburg
  @playwright/test@1.65.1 playwright-core@1.65.1`. A Playwright version other than the peer's is an
  npm resolution error.
- An embedded runtime has none of a Sandburg run's network controls: the app's requests are the
  browser's, with no egress allowlist ([Security](../guide/security.md)), and the app runs on the
  embedding page's origin. The browser runtime guide says so.

## Tests

- `test/runtime/browser-runtime.test.ts`: the directory as `scripts/browser-runtime.ts` builds it,
  served beside an embedder's page at another path (`Service-Worker-Allowed`), runs a project's Node
  server in Chromium. The page becomes cross-origin isolated after one reload, the embedder's own file
  under `pass` comes from its server, and the app sees itself at `/` and reaches its server by an
  absolute path.
- `test/pack/install.test.ts`: the packed package holds `dist/browser-runtime/`. Installed with the
  peers, the CLI and the library work as before. Installed alone, no Playwright is installed, the
  exports resolve to the runtime's files, and the CLI exits with code 2 and the install command.
- `test/unit/launch.test.ts`: the peers are optional, exact, and the development versions.
