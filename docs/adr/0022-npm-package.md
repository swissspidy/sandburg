# ADR 0022: Publish Sandburg as an npm package

- Status: Accepted
- Date: 2026-10-07

## Context

Sandburg ran only from a checkout. Its CLI and library are TypeScript that Node runs directly
(Node 22.18+ strips types). Node does not strip types under `node_modules`, so an installed copy
failed on its first import (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `npm pack` also took
the whole repository (1,546 files: the corpus, fixtures, evals, docs and tests).

The host page, the runtime's workers and the service worker are not loaded by Node. Sandburg
bundles them with esbuild from `src/` when a session needs them, and esbuild reads TypeScript
anywhere.

## Decision

- **`dist/` is the CLI and library compiled to JavaScript, with type declarations.** `tsc -p
  tsconfig.build.json` compiles from `src/index.ts` and `src/cli.ts`, rewriting `.ts` imports to
  `.js`. `npm pack` runs it (`prepack`); `dist/` is not committed. The package exports
  `dist/index.js` and `dist/index.d.ts`.
- **The package ships `bin/`, `dist/` and `src/`.** `src/` is what the browser side is bundled from.
  Code that names one of its files resolves it with `source()` ([`src/sources.ts`](../../src/sources.ts)),
  which gives the same `src/` path from `src/` and `dist/`. Packages are resolved with
  `require.resolve`, not by a path into `node_modules`, because npm may hoist them.
- **The browser side stays out of the declarations.** The host-side code imported two types from
  browser-only modules: the host page's API (`typeof api` in `host.ts`) and the runtime worker's
  messages (`worker.ts`). Declaring them pulled the whole runtime into the build, whose factories
  return classes with private members that declarations cannot express. `HostApi` and `RpcResult`
  are now declared in `host/types.ts`, which `host.ts` implements, and `FromWorker` is in
  `node-runtime/messages.ts`.
- **`bin/sandburg.js` runs `dist/` when it is under `node_modules`**, and `src/` otherwise, so a
  checkout needs no build.
- Every package the browser side imports is a dependency, not a dev dependency
  (`@pkgjs/parseargs`).
- **A missing Chromium names the command that installs it.** Playwright's message says
  `npx playwright install`, which fetches the latest Playwright, whose Chromium build may not be
  the one the installed Playwright drives. Sandburg says `npx playwright@<version> install chromium`
  with the installed version.
- **CI tests the package as installed** ([`test/pack/`](../../test/pack)). It packs the package,
  checks the file list, installs it into an empty project, and runs a fixture with a checks file
  typed from `sandburg`. It also checks the missing-Chromium message, and that the library imports
  and typechecks from a consumer.

## Consequences

- The package is 166 files, 1.1 MB unpacked (0.3 MB packed).
- **Releases use Changesets and npm's trusted publishing** ([`release.yml`](../../.github/workflows/release.yml)),
  as `swissspidy/playwright-webmcp` does. Pull requests add changesets; on `main`, Changesets keeps a
  "Version packages" pull request that bumps `package.json` and writes `CHANGELOG.md`. When `main`'s
  version has no tag yet (that pull request was merged), the workflow tests, packs and publishes it, then
  tags it and creates its GitHub release from its changelog section. npm accepts the workflow's OIDC
  token, so the repository stores no npm token, and publishes provenance.
- **Only the publishing job can request that token, and it installs nothing.** It publishes the tarball
  that an earlier job built, tested and packed, so no dependency's install script or test code runs where
  it could publish. The Changesets job, which can push and open pull requests, installs with
  `--ignore-scripts`. No job uses a dependency cache. The publishing job runs in the `npm` environment,
  which the package's trusted publisher names, and skips `npm publish` when the version is already on
  npm, so a run that failed after publishing can be re-run for its tag and release.
- The version stays 0.x: the library's API still changes with most changes to the runner.
