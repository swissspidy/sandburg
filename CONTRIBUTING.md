# Contributing to Sandburg

Thanks for helping. This page covers setting up a checkout, the test suites, and what a pull request
needs. The map of the code is [`docs/architecture.md`](docs/architecture.md); the reasons behind it are
the [ADRs](docs/adr/README.md). Security reports do not go here: see [SECURITY.md](SECURITY.md).
Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Sandburg needs Node.js 24 (LTS) or later (`engines.node` is `>=24`; CI runs 24).

```sh
npm ci
npx playwright install chromium     # on Linux, add --with-deps for its system libraries
npm run spike                       # one run of fixtures/vite-react-counter with its checks
```

A checkout runs its TypeScript sources directly (`node bin/sandburg.js …`); `npm run build` is only
needed for the packed package.

### Without the browser sandbox (root, containers)

Chromium runs inside its OS sandbox by default ([ADR 0061](docs/adr/0061-chromium-sandbox.md)). As
root (a dev container, most Docker images), or where unprivileged user namespaces are restricted
(Ubuntu 23.10 and later with AppArmor), it cannot start, and `sandburg` stops before the first run and
says what to change. Either change the host (run as a normal user;
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`), or turn the sandbox off for the whole shell,
which the CLI and the library read (and so the test suites, which run through them):

```sh
export SANDBURG_NO_BROWSER_SANDBOX=1
```

Only do that on a machine where running untrusted apps without the OS sandbox is acceptable: it
removes the boundary between the app and the machine (see [SECURITY.md](SECURITY.md#scope)).

## Running the tests

| Command | What | Needs |
|---|---|---|
| `npm test` | unit tests (`test/unit`) | nothing |
| `npm run typecheck` | `tsc` over the sources, tests and scripts | nothing |
| `npm run lint` | oxlint (type-aware, with Sandburg's own rules in `lint/`) and knip | nothing |
| `npm run test:runtime` | the runtime's loader and built-ins, in Chromium (`test/runtime`) | Chromium |
| `npm run test:e2e` | the fixtures end to end (`test/e2e`) | Chromium, network, Docker (else skipped) |
| `npm run test:pack` | packs the package, installs and runs it in an empty project | Chromium, network |
| `node scripts/pages/build.ts --verify` | builds the demo site and runs each demo | Chromium, network |

A single e2e file: `node --test --test-reporter=spec test/e2e/run.test.ts`. The unit tests'
timing assertions are off by default and run with `SANDBURG_PERF_TESTS=1`, one file at a time, as CI's
perf job does. Files listed in `test/budgets.json` have a time budget; CI warns about one over it.

Two generated files are compared by the unit tests. After changing what they describe, regenerate and
commit them:

```sh
node scripts/architecture.ts --update   # docs/architecture.md's tables (layers, environments)
node scripts/api-report.ts --update     # api/sandburg.api.md, after a change to the public API
```

### Wait for the thing, not a time

The rule for every test, from [`docs/testing.md`](docs/testing.md) and
[ADR 0060](docs/adr/0060-test-reliability-under-load.md): a test waits for what it waits for, never for
a fixed time. No `setTimeout(…, 300)` "for the channel to open": poll for the state with a deadline,
or have the code under test say when it is done (in the runtime tests, `until` and `channelOpen()`).
Timers a test races against use node:test's `mock.timers`. A longer timeout is a fix only with a
measured reason, and a test is never skipped, retried or loosened to make it pass.

Keep tests hermetic: temporary directories from `tempDir()` (`test/unit/temp-dir.ts`), servers on
port 0 on 127.0.0.1, and an `error` listener on every socket of a `node:net` server.

Before trusting a new test, or after changing one that waits, run it again and again under load:

```sh
node scripts/flakes.ts --runs 10 --cpu 4 test/unit/my-new.test.ts
```

## Lint and dead code

`npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with the config in
[`.oxlintrc.json`](.oxlintrc.json) and [knip](https://knip.dev) with [`knip.json`](knip.json). Both must
pass in CI. Some rules encode the security model and the architecture
([ADR 0053](docs/adr/0053-invariants-api-and-structure.md),
[ADR 0056](docs/adr/0056-architecture-rules-and-contracts.md)): `node:vm` is never a boundary,
`node:child_process` is allowed only in a few reviewed files, host caches are keyed by digests
(`sandburg/cache-key-digest`), the host has one server (`sandburg/one-host-server`), and browser modules
import nothing of Node's. Do not add a file to an exception list to quiet a rule without saying why in
the pull request. knip reports unused files, exports and dependencies: delete them rather than
ignoring them, and add a new entry point (a script, a worker) to `knip.json`'s `entry`.

## Changesets

A pull request that changes what the package does (its CLI, its API, its results, what runs or how
fast) adds a changeset:

```sh
npm run changeset
```

Pick the bump: patch for a fix, minor for a feature. Sandburg is 0.x, so a breaking change is a minor
too. Then write the changelog entry for someone who uses the package: what changed for them, not how.
Commit the file it writes in [`.changeset/`](.changeset/README.md). A change to tests, docs, CI or
scripts only needs none. The Release workflow gathers changesets on `main` into a "Version
packages" pull request; merging it tests and stages that version on npm with npm's trusted publishing
and provenance, tags it and creates its GitHub release. The version goes public once a maintainer
approves the staged publish on npmjs.com ([ADR 0022](docs/adr/0022-npm-package.md)).

## Architecture decision records

Write an ADR ([`docs/adr`](docs/adr/README.md)) when a change makes a decision someone would later
ask "why?" about: a new boundary or a change to the security model, a new contract between the host,
the page and the runtime, support for a framework or Node API that needed a design choice, a
performance change with its measurements, or a decision not to do something. A bug fix or a small
feature needs none; amend an existing ADR's status when a change reverses part of it.

An ADR is `docs/adr/NNNN-short-title.md`, numbered after the last one, and looks like the others:

```md
# ADR NNNN: Title

- Status: Accepted
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

with sections such as Measurements, Tests or "What did not help" where they apply. Measurements say
how they were taken (`node scripts/bench.ts`, the machine, the rounds). Add a row for it to the table
in [`docs/adr/README.md`](docs/adr/README.md), and when it amends or supersedes another ADR, update
that ADR's status and its row too.

## Adding a framework

Each framework is one entry in `FRAMEWORKS` in [`src/framework.ts`](src/framework.ts): how it is
detected (the table's order is detection's: frameworks built on Vite come before `vite`), its build
and cache directories, the dev caches kept between runs, telemetry switches, and how the node runtime
and the Docker reference start its dev server. Its name goes in the `Framework` union (`src/types.ts`)
and in [`src/result-schema.json`](src/result-schema.json); `test/unit/frameworks.test.ts` checks they
agree. Package-specific needs (source patches, WebAssembly builds) go in
`src/adapters/node/install-rules.ts`, by package. The full list is in
[docs/architecture.md, "Where to add things"](docs/architecture.md#where-to-add-things).

Add a fixture under [`fixtures/`](fixtures) with a `checks.spec.ts`, on the framework's latest
version ([ADR 0019](docs/adr/0019-latest-versions.md); Dependabot keeps it there), and an e2e test
for it. A framework that needed runtime work usually earns an ADR.

## Pull requests

- Branch from `main` and keep a pull request to one change. Describe what it changes and why, and how
  you tested it (the template asks).
- `npm run typecheck`, `npm run lint` and `npm test` pass locally; run the suites your change touches
  (`test:runtime` for the runtime, `test:e2e` files for a framework or the orchestrator).
- New behaviour comes with a test, and a fixed bug with a test that failed before the fix.
- A changeset if the package's behaviour changes, an ADR if a decision was made, and the README or
  docs updated where they describe what changed.
- A pull request that changes `src/`, `pages/`, `scripts/bench.ts`, the unit tests with timing
  assertions (`test/unit/await-context.test.ts`, `test/unit/host-socket.test.ts`), `package-lock.json`,
  the perf workflow or `.github/actions/setup-chromium/` is benchmarked against its base branch in CI;
  it fails when a median is more than 30% slower. Explain a slowdown you accept.
- Security fixes do not start as a pull request: report them first ([SECURITY.md](SECURITY.md)).
