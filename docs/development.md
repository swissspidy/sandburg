# Development

How Sandburg is built, tested and released. The user guides are in [`guide/`](guide); the map of the
code is [`architecture.md`](architecture.md), and the design decisions are the [ADRs](adr/README.md).

## How it works

1. **The host** (the orchestrator, in Node.js) installs the project's packages with npm
   (`--ignore-scripts`) and serves them to the browser. It also compiles modules for the runtime and
   keeps the caches. With `--install-in browser`, the page installs and compiles instead.
2. **The runtime** is Node.js 24 in a Web Worker: a virtual file system, a CommonJS/ESM loader, and
   Node's built-in modules. It runs the project's dev script. Child processes and worker threads are
   more runtimes.
3. **A service worker** gives the app its origin: the page's requests go to the servers listening
   in the runtime, with streaming and WebSockets.
4. **Playwright** runs the checks in the app's frame, and collects screenshots, accessibility trees,
   console errors and network failures.

The map of the code (where each module runs, what may import what, the contracts between the parts,
where to add a framework) is [`docs/architecture.md`](architecture.md), kept true by
`test/unit/architecture.test.ts`. The design decisions are recorded in [`docs/adr`](adr). [ADR 0006](adr/0006-node-runtime.md)
covers the runtime, and [ADR 0014](adr/0014-node-runtime-only.md) covers the single runtime and the
cold-start work. [ADR 0001](adr/0001-runtime-adapters-serving-results.md) gives each sandbox its own origin and
routes every request through the egress gateway (allowlist, cache);
[ADR 0005](adr/0005-wordpress-playground.md) (named for an adapter since removed) adds a per-sandbox egress proxy
for what the gateway cannot intercept; [ADR 0054](adr/0054-security-review-round-4.md) maps every boundary an app
can reach and how the host holds it.

## Commands

```sh
npm test               # unit tests
npm run lint           # oxlint (type-aware, with Sandburg's own rules) and knip
npm run test:runtime   # the runtime's loader and built-ins, in Chromium
npm run test:e2e       # fixtures end to end (the first run needs network access; Docker tests skip without Docker)
npm run typecheck
npm run build          # dist/: the CLI and library as JavaScript, with types (npm pack runs it)
npm run test:pack      # pack the package, install it into an empty project, run a project with it
node scripts/pages/build.ts --verify   # the demo site, into dist-pages/
node scripts/profile.ts <project>      # where a run's time goes: V8 CPU profile of every thread, by package
node scripts/bench.ts                   # A/B benchmark of two revisions (default origin/main vs this checkout), cold and warm
node scripts/edit-loop.ts               # edit-to-render latency of the fixtures
node scripts/flakes.ts --cpu 4 <files>  # run test files again and again under load, and count what fails
node scripts/architecture.ts --update   # regenerate docs/architecture.md's tables (the unit tests compare them)
node scripts/api-report.ts --update     # regenerate api/sandburg.api.md after a change to the public API
```

## Tests

How to keep tests reliable (waiting for the thing, not for a time; hermetic temp dirs and ports) is in
[`docs/testing.md`](testing.md) ([ADR 0060](adr/0060-test-reliability-under-load.md)).

## The demo site

The demo site replays the host's answers from static files, recorded when the site is built
([ADR 0015](adr/0015-static-demos.md)). The generator page installs and compiles in the page, so it
only needs the runtime's own files ([ADR 0021](adr/0021-generate-in-the-browser.md));
`--verify` runs each of its framework scaffolds, and `--only generate` builds it alone. A GitHub Actions
workflow builds and deploys the site on every push to `main`, and builds and verifies it, without
deploying, for a pull request that changes the demos, `src/` or the packages.

## CI

CI runs on every pull request and push to `main`. It runs typecheck, lint and unit tests on Node 24 (LTS),
the runtime tests in Chromium, the packed package, the GitHub Action (`uses: $/`, with the package
packed from the same commit, on `fixtures/vite-react-counter`), and each e2e file as its own job; the
Docker reference tests run there too. Each job reports its tests' times, with a warning annotation for
a file over its budget in `test/budgets.json`.
A pull request that changes `src/`, `pages/`, `scripts/bench.ts`, the unit tests with timing assertions,
`package-lock.json` or the perf workflow is also benchmarked against its base branch: `vite-react-counter` and `next-app-router`, warm and cold.
That job fails only when a median is more than 30% slower, or when a side has no result; it also runs
the unit tests' timing assertions (`SANDBURG_PERF_TESTS=1`), one file at a time. zizmor checks the workflows, and Dependabot proposes npm and GitHub Actions updates weekly,
after a week's cooldown. Every action is pinned to a commit, and the jobs that launch Chromium share one setup
with a cached browser ([ADR 0062](adr/0062-ci-setup-and-coverage.md)).

## Releases

A pull request that changes what the package does adds a changeset (`npx changeset`): the bump and a line
for the changelog ([`.changeset/`](../.changeset)). The Release workflow gathers them on `main` into a
"Version packages" pull request, and starts CI on its branch with a dispatch (its pushes, made with the
workflow's token, start none themselves; the results are in Actions, not in the pull request's checks);
merging it tests and stages that version on npm with npm's trusted
publishing (no npm token in the repository) and provenance, tags it and creates its GitHub release. The
version goes public once a maintainer approves the staged publish on npmjs.com.

The GitHub Action ([`action.yml`](../action.yml)) installs the package version its ref's
`package.json` names. It ships with the first release after it was added: no earlier tag has it.
Nothing moves a `v0` major tag; a maintainer moves it at a release, after the version is public
([Agents and CI](guide/agents-and-ci.md#versions-and-tags)).

Networks that re-terminate TLS are covered in [Security](guide/security.md#networks-that-re-terminate-tls).
