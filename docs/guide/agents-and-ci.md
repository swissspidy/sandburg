# Agents and CI

Sandburg is made to be called by something that is not a person: a coding agent that wants to know
whether the app it wrote works, or a CI job that checks every generated app. Both read the same
result: an exit code, and a `result.json` that says what failed and why.

## From a coding agent

Give the agent one command, and let it read the result:

```sh
npx sandburg run . --checks checks.spec.ts --checks-in page --json
```

- **The exit code** answers "does it work": `0` passed, `1` a blocking check failed, `2` the run did
  not reach the checks (or they did not finish in time, or the project or checks file did not load),
  `64` a usage error ([CLI](cli.md#exit-codes)).
- **`--json`** prints the whole [`RunResult`](library.md#resultjson) instead of the summary, so the
  agent does not parse text. Without it, the summary's last line names `result.json`.
- **`--checks-in page`** runs checks the agent wrote in the sandbox tab, not in Sandburg's process
  ([below](#the---checks-in-page-trust-model)).
- **`--install-in browser`** keeps the install off the host too: the page installs the packages from
  the npm registry and the host only serves static files.

The untrusted part of an app-building task is the app: the packages it installs, its dev server, the
code the agent wrote. That is what runs in Sandburg. The agent's own process is not sandboxed: limit
what it may run with its own permissions, so that it runs `sandburg` and not `npm` or `node`
on the app.

### Harbor

[`integrations/harbor`](../../integrations/harbor/README.md) runs [Harbor](https://harborframework.com)
tasks without containers: the agent works in a per-trial directory and calls `sandburg run .` to see
whether the app works; the verifier runs the app the same way with the task's checks. The trial's
`sandburg` is fenced ([`fence.mjs`](../../integrations/harbor/fence.mjs)): only `sandburg run`, every
path inside the trial's project, packages installed in the browser and checks run in the page.

## Interpreting results

Read `status` first, then `failure`:

| `status` | `failure.class` | What to do |
|---|---|---|
| `passed` | | Nothing: the app works. Non-blocking findings (failed requests, axe violations) are in `checks[]` and `network`. |
| `failed` | `app-bug` (`blocking-check-failed`) | The app runs, a check does not hold. The failed checks are in `checks[]` with their `message`; `failure.evidence` adds the app's uncaught errors. Fix the app (or the check). |
| `error` | `app-bug` (`compile-error`, `undeclared-import`, `unresolvable-dependency`, `app-error-before-ready`, …) | The app does not start. `failure.message` names the file and line the dev server reported, or the package that is missing from `package.json` or not on the registry. Fix the app. |
| `error` | `runtime-unsupported` | The app needs something Sandburg's runtime does not do ([What runs](../../README.md#what-runs)). Changing the app (another package, no native addon) helps; running it again does not. |
| `error` | `timeout` | A phase ran out of time (`failure.phase`). For `checks`, the checks that finished are kept, the running one failed and the rest are `skipped`. Look at `phases[]` and the runtime log. |
| `error` | `infra` | Sandburg's machinery or the network failed: a download, a crashed tab, an `--offline` cache miss. It was already retried once (`previousAttempts`); run it again later. Not the app's fault. |
| `error` | `unknown` | Nothing matched (`unmatched`), or the checks file did not load (`checks-load`). `failure.message` and `evidence` have what there is. |

`failure.rule` names the rule that decided it, so a wrong verdict can be traced to its rule
([`src/classify.ts`](../../src/classify.ts), [Library](library.md#failure-classes)). For a person,
`screenshot.png` and `a11y.yaml` next to `result.json` show what the app rendered, and
`sandburg open snapshot:<id>` loads the exact project again in a visible tab.

## The `--checks-in page` trust model

A checks file is imported by Sandburg's Node process: it can do anything a program on this machine
can. That is fine for checks you wrote, not for checks an agent wrote, which are as untrusted as the
app.

With `--checks-in page` ([ADR 0023](../adr/0023-checks-in-the-page.md)):

- the host reads the file and strips its TypeScript types (esbuild's transform of one file: no import
  is resolved, and nothing of it runs on the host);
- the sandbox tab loads it as a module and runs its checks against the app's frame. The tab and the app
  share an origin, so the checks can do no more than the app's own code;
- results come back as data (names, statuses, messages, durations), validated and capped.

The checks keep Playwright's shape (`app`, `expect`, `appUrl`, locators, actions and web-first
assertions), so the same file runs either way; its limits are in
[Writing checks](writing-checks.md#checks-in-the-page---checks-in-page). Run the checks you wrote
yourself (a verifier's) on the host, and the agent's in the page.

## GitHub Action

The repository is a composite action ([`action.yml`](../../action.yml)) that runs one project. It ships
with the first release after it was added: no tag before that has `action.yml`. Until then, pin it to a
commit of `main` (or use `@main`, which moves):

```yaml
jobs:
  sandburg:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - id: sandburg
        uses: swissspidy/sandburg@<commit sha> # main
        with:
          project: ./my-app
          checks: ./my-app/checks.spec.ts
          args: --checks-in page
      - if: always()
        run: echo "Sandburg: $STATUS ($RESULT)"
        env:
          STATUS: ${{ steps.sandburg.outputs.status }}
          RESULT: ${{ steps.sandburg.outputs.result-path }}
```

Once a release has it, pin to that release's commit, as you pin other actions
([Versions and tags](#versions-and-tags)).

What it does:

1. Sets up Node.js (`node-version`) with `actions/setup-node`. That Node.js stays on the `PATH` for the
   job's later steps too: set up your own after it if they need another version.
2. Installs the `sandburg` package from npm into the runner's temp directory, not the project.
3. Lifts Ubuntu's AppArmor restriction on unprivileged user namespaces, so that Chromium's OS sandbox
   can start (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`). That changes the host
   until it reboots: on a GitHub-hosted runner the VM is gone after the job, but on a self-hosted
   runner it stays changed for every later job. `allow-chromium-sandbox: false` skips it.
4. Installs Playwright's Chromium, cached, with its system libraries only if it does not start without
   them.
5. Runs `sandburg run --json`, writes the checks to the job summary, and uploads `.sandburg/runs` as an
   artifact, also when the run failed. The step fails when `sandburg` exits non-zero.

It runs on Linux runners (`ubuntu-latest`), where this repository's CI tests it.

| Input | Default | What it is |
|---|---|---|
| `project` | `.` | The project: a directory, a `.zip`, a JSON file tree or `snapshot:<id>`, relative to the workspace. |
| `checks` | | A checks file (`--checks`). Empty: only the built-in checks. |
| `args` | | More options for `sandburg run`, split on whitespace (no quoting), e.g. `--checks-in page --ready main`. Results always go to `.sandburg/runs`: do not pass `--out`. |
| `node-version` | `24` | The Node.js version to set up (24 or later). |
| `sandburg-version` | the action ref's version | See [below](#which-sandburg-it-installs). |
| `allow-chromium-sandbox` | `true` | Lift the AppArmor restriction (step 3). `false` leaves the host as it is: where the restriction is on, Sandburg then stops and says what to change. |
| `artifact-name` | `sandburg-runs` | The uploaded artifact's name. Set it per job in a matrix: two jobs cannot upload the same name. |

| Output | What it is |
|---|---|
| `status` | `passed`, `failed` or `error` (also when `sandburg` printed no result: a usage error, a project that is not there). |
| `result-path` | The run's `result.json`, relative to the workspace; empty when there is none. |

To run more than one project, use a matrix over `project` (with `artifact-name`), or call
`npx sandburg batch` in a step of your own.

### Which sandburg it installs

By default, the version in the `package.json` of the action's ref: the latest release when that ref is
`main` between releases, and the release itself when it is a release's commit. `sandburg-version` takes:

- **a version, range or dist-tag** of the `sandburg` package: `0.2.0`, `^0.2`, `latest`;
- **a path**, starting with `./`, `../`, `/` or `~/`, or ending in `.tgz`, relative to the workspace:
  a packed package (`npm pack`) or a directory;
- **any other npm spec**, passed to `npm install` as it is. It comes after `--`, so a value that starts
  with `-` is a package name, never an npm option.

This repository's CI runs the action from its checkout (`uses: $/`, the self-repository form of `./`)
on [`fixtures/vite-react-counter`](../../fixtures/vite-react-counter), with the package packed from the
same commit, so it keeps working (the `action` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

### Versions and tags

The Release workflow tags each version (`vX.Y.Z`) and creates its GitHub release; a release's tag is the
ref to use for the action from then on, pinned to its commit. Nothing creates or moves a `v0` major tag.
If the project offers `@v0`, a maintainer moves it at each 0.x release, once the version is public on
npm:

```sh
git tag -f v0 vX.Y.Z && git push -f origin v0
```

## In CI without the action

The same steps, in a workflow of your own:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 24
- run: npm install --save-dev sandburg
- run: npx playwright install --with-deps chromium
- run: npx sandburg run ./my-app --checks ./my-app/checks.spec.ts --json > sandburg.json
- uses: actions/upload-artifact@v7
  if: always()
  with:
    name: sandburg-runs
    path: .sandburg/runs
```

- Install the Chromium of the Playwright version Sandburg depends on: `npx playwright install chromium`
  from a project that has `sandburg` installed does that. Cache `~/.cache/ms-playwright` on that
  version.
- On Ubuntu 23.10 and later (`ubuntu-24.04`, `ubuntu-latest`), Chromium's sandbox needs
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` first
  ([Troubleshooting](troubleshooting.md#the-browser-sandbox)). In a container that runs as root, run
  Sandburg as another user, or pass `--no-browser-sandbox` and know what it turns off.
- `sandburg batch <dir> --json` prints a `BatchSummary` for many projects at once, and exits `2` if a
  run ended in error, else `1` if one failed.
- `--offline` with a restored `.sandburg/cache` runs without network access, and fails on a miss.
