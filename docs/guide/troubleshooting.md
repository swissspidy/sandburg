# Troubleshooting

## Chromium is not installed

Sandburg drives Chromium with the Playwright it installs. If that Playwright's Chromium is missing,
the run stops (exit code `2`) and prints the command that installs it:

```text
error: Chromium for Playwright 1.64.1 is not installed. Run: npx playwright@1.64.1 install chromium (on Linux, add --with-deps for its system libraries), or set SANDBURG_CHROMIUM to a Chromium binary.
```

- `npx playwright@<version> install chromium` installs it; on Linux, add `--with-deps` for its system
  libraries (that runs apt, with `sudo`).
- `SANDBURG_CHROMIUM=/path/to/chrome` uses another Chromium instead (`executablePath` in
  `SessionOptions`).
- From a checkout, `npx playwright install chromium` installs the Chromium of the Playwright version
  the checkout pins.

## The browser sandbox

Sandburg runs Chromium inside its OS sandbox ([Security](security.md#the-browser-sandbox),
[ADR 0061](../adr/0061-chromium-sandbox.md)). Where the sandbox cannot start, `sandburg` stops before
the first run (exit code `2`) and says what to change. It does not fall back on its own.

```text
error: Chromium's OS sandbox could not start on this host. Sandburg runs the browser sandboxed and does not fall back to running it without the sandbox. …
```

On Linux the sandbox needs unprivileged user namespaces:

- **Ubuntu 23.10 and later** (and GitHub's `ubuntu-24.04` runners) restrict them with AppArmor.
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` lifts that until the next boot (a file
  in `/etc/sysctl.d/` keeps it), as does an AppArmor profile for the Chromium binary. Check with
  `sysctl kernel.apparmor_restrict_unprivileged_userns` (`1`: restricted).
- **As root**, Chromium does not use them: the message then adds "Sandburg is running as root". Run
  Sandburg as another user. In a Docker container, that is a `USER` other than root; the container may
  also need a seccomp profile that allows `unshare`/`clone` with new user namespaces.
- **Without user namespaces at all** (`kernel.unprivileged_userns_clone=0` on some kernels, or
  `user.max_user_namespaces=0`), enable them.

Where none of that is possible, turn the sandbox off, explicitly: `--no-browser-sandbox`,
`SANDBURG_NO_BROWSER_SANDBOX=1`, or `new Session({ browserSandbox: false })`. The CLI warns
(`warning: Chromium's OS sandbox is off …`), and each `result.json` (`environment.browserSandbox`) and
batch `summary.json` (`browserSandbox`) records it. The app is still held by its own origin and the
egress gateway; what is lost is the OS boundary around the renderer.

## What is not supported

What runs is in the README's [What runs](../../README.md#what-runs). What does not, and what you see:

| Not supported | What you see |
|---|---|
| Native addons without a WebAssembly build | `error`, `runtime-unsupported`, rule `signature:native-addon` (a `.node` file that cannot load, `node-gyp`, `NODE_MODULE_VERSION`). |
| Programs other than Node (`git`, `python`, …) | They exit with 127 (command not found), as in a shell without them, also under `execSync` and `spawnSync` ([ADR 0063](../adr/0063-synchronous-child-processes.md)). A dev script that needs one fails at `start`. |
| A server started synchronously (`execSync('npm run dev')`) | The call blocks its caller for good (until its own `timeout` option), and nothing can reach the server: the run waits until a phase runs out of time. Start servers with `spawn`. Synchronous child processes that end (`execSync('node build.js')`) work. |
| Dependencies that are neither npm registry versions nor packages inside the project: git, URL, `user/repo` shorthands, local tarballs (`file:x.tgz`), paths outside the project | The run fails before anything is installed: `runtime-unsupported`, rule `probe-unsupported`, naming the dependency (`…: it points outside the project; only packages inside the project are linked`). Also when a registry package pulls one in. Workspaces and `file:`, `link:` and `workspace:` packages inside the project are linked ([ADR 0064](../adr/0064-monorepos-and-local-packages.md)). |
| A Node.js built-in the runtime does not implement | `runtime-unsupported`, rule `signature:missing-builtin` (`Cannot find module 'node:…'`) or `signature:stubbed-builtin` (`… not supported`). |
| A framework that requires a newer Node.js than the runtime's (Node 24) | `runtime-unsupported`, rule `signature:node-version`. |
| A WebAssembly build that traps (a native tool's port) | `runtime-unsupported`, rule `signature:wasm-trap` or `signature:wasm-thread-crash`. Running it again sometimes passes; report it. |
| A project with no way to start it (no dev or start script, no `index.html`) | `runtime-unsupported`, rule `probe-unsupported`: `no way to start this project in the node runtime (dev/start script: "…")`. |

A request to a host outside the allowlist is blocked: it shows in `network.blocked` and in the
non-blocking `network` check, and fails the run only if the app breaks without it.

## Reading a failure

Every failure has a class (`app-bug`, `runtime-unsupported`, `timeout`, `infra`, `unknown`) and names the
rule that decided it ([`src/classify.ts`](../../src/classify.ts)). The CLI's summary prints it:

```text
  failure  app-bug in start [compile-error]: src/App.tsx:3:1: Unexpected token
```

- **`app-bug`**: the app is wrong; it would fail the same way anywhere. The message points at the
  file and line where the dev server reported it (`compile-error`), names the package the project
  imports but does not declare (`undeclared-import`) or that the registry does not have
  (`unresolvable-dependency`), says the server could not render the app's page (`server-render-error`), says
  a local package or workspace it names is not there (`adapter-code:APP`), or lists the failed checks
  (`blocking-check-failed`).
- **`runtime-unsupported`**: see [above](#what-is-not-supported).
- **`timeout`** (`phase-deadline`): a phase ran out of time, with no compile error or other cause
  found. `ready` is the usual one: the dev server started but the page never rendered. Try `sandburg
  open` to watch it, `--ready <selector>` if it renders a loading state first, or larger `timeouts` in
  the library. A cold run of a large framework (Next.js) is the slowest; the next one is faster.
- **`infra`**: Sandburg's machinery or the network failed (`runtime-boot-fetch`,
  `signature:download-failed`, `infra-error`: a broken download, a crashed tab, an `--offline` cache
  miss). It is retried once on its own (`previousAttempts` lists the earlier run). Behind a proxy that
  re-terminates TLS, set `SANDBURG_EXTRA_CA_CERTS` ([Security](security.md#networks-that-re-terminate-tls)).
- **`unknown`** (`unmatched`, `checks-load`, a `project-load` of a path that is not there): nothing
  matched. `failure.evidence`, `pageErrors`, `console` and the runtime log have what there is.

The full table of classes and rules is in the [library guide](library.md#failure-classes);
`sandburg compare` measures how often the verdicts agree with a Docker reference
([`docs/fidelity`](../fidelity/README.md)).

## Looking at a run

- `.sandburg/runs/<runId>/` has `result.json`, `screenshot.png`, `a11y.yaml` and the runtime's log.
- `sandburg open <project>` (or `snapshot:<id>` from `result.json`'s `project.snapshotId`) loads it in
  a visible tab and keeps it open, also when a phase before the checks failed.
- `--headed` shows the browser for a `run`.
- `node scripts/profile.ts <project>`, from a checkout, shows where a run's time goes.
