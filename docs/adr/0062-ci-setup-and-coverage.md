# ADR 0062: CI: one Chromium setup, a browser cache, and the runs that were missing

- Status: Accepted
- Date: 2026-10-27

## Context

After ADRs 0043 and 0061, the steps that ready Chromium (lift the AppArmor restriction on user
namespaces, install the browser, apt only if it does not start) were copied into seven jobs, and they
had drifted: the perf, release (pack) and Pages jobs still ran `playwright install --with-deps`, the
apt step ADR 0043 removed from CI because it once took 7 min 20 s. Every job downloaded the browser
again (Chrome for Testing 191 MB, the headless shell 120 MB, FFmpeg; 8-12 s of the step in CI run
40422846213).

Some runs never happened:

- **The demos.** Pages' "Build and verify the demos", the slowest job (~275 s), ran only on `main`, so a
  change that broke a demo showed after its merge.
- **The "Version packages" pull request** (#38) never had CI: changesets/action pushes its branch with
  the workflow's `GITHUB_TOKEN`, and GitHub starts no workflow for such a push.
- **The unit tests' timing assertions** (`SANDBURG_PERF_TESTS`, in `await-context` and `host-socket`)
  are off by default, because files run in parallel under `node --test`, and nothing turned them on.

npm 11 (Node 24) blocks dependencies' install scripts that `allowScripts` in package.json does not
name, and warned on every `npm ci` about esbuild's postinstall.

## Decision

- **`.github/actions/setup-chromium`**, a composite action, is the one place that readies Chromium.
  Every job that launches it uses it after `npm ci`. No job runs apt unless Chromium fails to start.
- **The browser is cached** (`~/.cache/ms-playwright`, `actions/cache`), keyed on the OS, the
  architecture and playwright-core's version in package-lock.json: a Playwright version pins its
  browser builds, so the key changes exactly when they do. On a hit, `playwright install` finds them
  and downloads nothing; the launch check, and apt only on its failure, are unchanged. The release's
  pack job passes `cache: "false"`, as it already used no npm cache: a release uses nothing another run
  saved.
- **Pages runs on pull requests** that change `pages/`, `src/`, `scripts/pages/`, `fixtures/` (the
  demos run fixtures), `package.json`, `package-lock.json`, the workflow or the action: build and `--verify`, and the screenshots. The
  Pages artifact upload and the deploy job are skipped for a pull request, and the concurrency group
  of a pull request's run is its own, so it never cancels a deployment.
- **CI for the "Version packages" pull request**: ci.yml takes `workflow_dispatch`, and release.yml's
  `version-ci` job (only `actions: write`) runs `gh workflow run ci.yml --ref changeset-release/main`
  when changesets/action reports a pull request (`pr-number`). A dispatch is the one event the
  workflow's token can start. It tests the release branch: the run is in Actions, and its check runs
  are on the branch's head commit (a dispatch runs on the branch's last commit). GitHub does not
  show a workflow_dispatch run's checks in the pull request's checks section, and they do not
  satisfy required status checks ("Troubleshooting required status checks" in GitHub's docs). No
  secret is added, and publishing is unchanged. Creating the pull request with a GitHub App's or a
  fine-grained PAT's token (changesets/action's `github-token`) would start the usual
  `pull_request` CI, with checks on the pull request; that needs a secret, and is the owner's call.
- **The perf workflow runs the timing assertions**: `SANDBURG_PERF_TESTS=1`, `--test-concurrency=1`,
  after the benchmark (and whatever it found, so neither hides the other).
- **The Docker reference runs `node:24-slim`** (was `node:22-slim`), the Node line of `engines` and of
  the browser runtime.
- **Budgets** for the two suites without one, about twice their time in CI run 40422846213:
  `e2e/renderer-memory` 10 s (3.8 s), `pack/install` 40 s (19.1 s).
- **esbuild's postinstall stays off**, recorded as `"allowScripts": { "esbuild": false }` (`npm
  install-scripts deny esbuild`). The script (`install.js`) checks that the platform's binary package
  (`@esbuild/linux-x64`, an optional dependency npm installs) is there, downloads one if not, and
  swaps `bin/esbuild`'s JavaScript shim for the binary. Sandburg uses esbuild's JavaScript API, which
  finds the binary package itself: with the script skipped, a build runs (checked on npm 11.19.1), and
  CI has run that way since npm 11. Skipping it keeps the default of no dependency code at install.

## Consequences

- One action to change for the next Chromium setup step; the drift between jobs is gone.
- A job with a cache hit restores ~300 MB instead of downloading it. The first run after a Playwright
  bump downloads and saves it.
- Pull requests that touch the demos take ~5 more minutes of runner time, in parallel with CI.
- The "Version packages" branch is tested by the same suite as any other; a failure shows in Actions
  and on its head commit, not in the pull request's checks, and required checks are not met by it.
- A machine where `@esbuild/<platform>` cannot be installed (optional dependencies off) has no esbuild
  binary: npm would have fetched it with the script. CI and the supported platforms install it.
