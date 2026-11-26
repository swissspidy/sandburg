# The CLI

```text
sandburg <command> [options]
```

`sandburg --help` prints the same commands and options. From a checkout, `node bin/sandburg.js` runs the
CLI from its TypeScript sources.

## Commands

| Command | What it does |
|---|---|
| `sandburg run <project>` | Run one project and check it. |
| `sandburg batch <dir>` | Run every project in `<dir>` (subdirectories, `.zip` or `.json`), N tabs at a time. |
| `sandburg open <project>` | Load a project in a visible browser tab and keep it open. |
| `sandburg snapshot <project>` | Store a project in the snapshot store and print its id. |
| `sandburg compare <dir>` | Run projects in the browser and in a Docker reference; report agreement. |
| `sandburg serve <project>` | Serve a project for your own browser: no Playwright, no sandbox, no checks ([`serve`](#serve)). |

```sh
sandburg run <project> [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                     # each subdirectory, .zip or .json in <dir> is a project
sandburg compare <dir> --reference docker [--report path]
sandburg snapshot <project>                             # store it, print its snapshot id
sandburg open <project>                                 # load it in a visible tab
sandburg serve <project> [--host 127.0.0.1] [--port 8787]  # serve it for your own browser
```

## Project inputs

`<project>` is one of:

- a **directory**;
- a **`.zip`** (a single top-level folder is stripped);
- a **JSON file tree**: `{ "path": "contents" }`;
- **`snapshot:<id>`**, or a unique prefix of the id (at least 8 hex characters), from the snapshot store.

A workspace package's directory runs in its monorepo: when a directory above `apps/web` declares
workspaces (npm, pnpm or yarn) that name it, `sandburg run mono/apps/web` loads all of the monorepo's
files and runs `apps/web`'s `dev` (or `start`) script in its directory. A directory that no workspace
pattern names is loaded alone ([ADR 0064](../adr/0064-monorepos-and-local-packages.md)).

What is never part of the app's sources is left out at any depth (installs such as `node_modules`,
`.git`, tools' caches and output), and build output is left out at the project's root only
([`src/project.ts`](../../src/project.ts)).

### Snapshots

Every run stores its project as a content-addressed snapshot (in `.sandburg/store`, or `--store <dir>`),
so any run can be reopened exactly: its `result.json` has `project.snapshotId`.

```sh
sandburg snapshot ./my-app          # prints the id
sandburg run snapshot:3f9a1c0b72d4   # runs it again, from the store
sandburg open snapshot:3f9a1c0b72d4  # looks at it in a visible tab
```

Snapshots and batches are described in [ADR 0002](../adr/0002-snapshots-and-batches.md).

## Options

| Option | Default | What it does |
|---|---|---|
| `--runtime <name>` | `node` | The in-browser runtime; `node` is the only one. |
| `--install-in <where>` | `host` | `host`: npm on the host. `browser` (opt-in): the page installs from the npm registry itself. See [below](#--install-in-browser). |
| `--checks <file>` | | Checks file; its default export maps check names to functions ([Writing checks](writing-checks.md)). In `batch` and `compare`, a project's own checks file takes precedence. |
| `--checks-in <where>` | `host` | `host`: the checks file is imported by Sandburg's process. `page`: its code runs in the sandbox tab, with Playwright-shaped locators and `expect` ([Writing checks](writing-checks.md#checks-in-the-page---checks-in-page)). |
| `--parallel <n>` | one per core, up to 8 | `batch`/`compare`: tabs at a time. |
| `--no-prewarm` | | `batch`/`compare`: do not warm up common stacks first (the warm-up only runs when their installs are missing). |
| `--no-longest-first` | | `batch`: start the projects in the order found (by name). By default a batch orders them by its earlier batches (`.sandburg/batches`): first those with no earlier run (or none with a checks time, such as a run that failed before its checks), then those whose checks took 3 s or more, longest first, then the rest by the time before their checks, longest first. That shortens its wall time, but the order then differs from batch to batch, and so does what each app runs beside. Use this to compare two batches' per-app times. `compare` does not take it. |
| `--out <dir>` | `.sandburg/runs` | Results directory. |
| `--cache <dir>` | `.sandburg/cache` | HTTP cache directory. |
| `--store <dir>` | `.sandburg/store` | Snapshot store directory. |
| `--offline` | | Serve only from the cache; never fetch upstream. See [below](#--offline). |
| `--ready <selector>` | | Wait for this selector before running checks. |
| `--save-files <regex>` | | `run`, with a project directory: write the app's matching files back. See [below](#--save-files). |
| `--headed` | | Show the browser window (`open` always does). |
| `--no-browser-sandbox` | sandboxed | Run Chromium without its OS sandbox, only for hosts where it cannot start (as root, or user namespaces restricted). Also `SANDBURG_NO_BROWSER_SANDBOX=1`. Results record it. See [Troubleshooting](troubleshooting.md#the-browser-sandbox). |
| `--browser-sandbox` | | Run it sandboxed even where `SANDBURG_NO_BROWSER_SANDBOX=1` is set. |
| `--json` | | Print the full JSON result (`run`), batch summary (`batch`) or report (`compare`) instead of a summary. |
| `--reference <name>` | `docker` | `compare`: the reference runtime (`docker`, the default and only one). |
| `--report <path>` | `.sandburg/reports/fidelity` | `compare`: write the report to `<path>.md` and `<path>.json`. |
| `-h`, `--help` | | Show the help. |

### `--offline`

`--offline` answers every request from the HTTP cache (`.sandburg/cache`) and fails on a miss. An
install the project still needs is made by npm with `--offline`, from npm's own cache alone. Run the
project once online to fill the caches, then run it offline as often as you like. A miss is an `infra`
failure.

### `--install-in browser`

`--install-in browser` (opt-in) has the page install the packages from the npm registry and compile
modules itself: the host only serves static files ([ADR 0018](../adr/0018-browser-install.md),
[ADR 0020](../adr/0020-compile-in-the-page.md)). The
[demo generator](https://swissspidy.github.io/sandburg/generate/) installs this way, and so does the
`sandburg` that Harbor's trials may run, which is limited to `sandburg run`
([Agents and CI](agents-and-ci.md#harbor)).

### `--save-files`

`--save-files <regex>` (`run`, with a project directory) writes the app's files whose path matches
`<regex>`, as they are after the checks (its SQLite database, say), back into the project. The pattern
decides what is written: anchor it, e.g. `--save-files '\.db$'`.

Only relative paths outside `node_modules`, dot directories and `.git` are kept; over 1000 files or
256 MB, nothing is written, and the CLI says why (`--save-files: nothing written: …`). A file that could
not be written is listed (`--save-files: not written: …`). An invalid pattern is a usage error.

## `batch`

`sandburg batch <dir>` runs each subdirectory, `.zip` or `.json` in `<dir>` as a project.

- `batch` and `compare` run one tab per core, up to 8, by default (`--parallel`).
- A project's own `checks.spec.ts` (or `app.checks.spec.ts` next to `app.zip`) takes precedence over
  `--checks`.
- Directories whose name starts with `.`, and archives or JSON files whose name starts with `.` or
  `_`, are skipped.
- Each run prints a line (status, time, label, and its failure's class and rule). The batch writes
  `.sandburg/batches/<batchId>/summary.json` (`BatchSummary`: totals by status and failure class,
  cache hits, blocked requests, `browserSandbox`, and every run). `--json` prints it.

## `compare`

`compare --reference docker` runs each project in the browser and installs and starts it with real
npm in a Docker container: `npm install` runs the dependencies' lifecycle scripts and `npm run dev` the
project's own code, with the project directory mounted. It reports how often the two agree, by
framework, with timings, to `<report>.md` and `<report>.json`.

**The Docker reference is not a security boundary**: use it only on projects you trust. When the host's
proxy listens on its loopback only, the container shares the host's network and can reach every service
on it ([ADR 0004](../adr/0004-docker-reference-and-fidelity-study.md)). Its containers are labelled
`sandburg.ref` and removed when the run ends, on Ctrl-C, and by the next `compare` after a crash.

The study method and every report are in [`docs/fidelity`](../fidelity/README.md).

## `open`

`sandburg open <project>` runs the project in a visible browser and keeps the tab open after the run,
also when a phase before the checks failed: to look at an app, or at why it failed.

## `serve`

`sandburg serve <project>` serves the project for your own browser, where `open` drives Playwright's:
for a machine where Playwright cannot run (a remote dev box, a container) or a person who wants to
click through an app ([ADR 0075](../adr/0075-serve.md)). It prints an address
(`http://localhost:8787/` by default); the page there installs the project's packages from the npm
registry, starts its dev server in the browser runtime ([Embedding the browser runtime](browser-runtime.md))
and shows the app. It runs until Ctrl-C.

```sh
sandburg serve ./my-app
sandburg serve ./my-app --port 0          # a free port
ssh -N -L 8787:localhost:8787 user@devbox   # on your machine, for a project served on devbox
```

| Option | Default | What it is |
|---|---|---|
| `--host <address>` | `127.0.0.1` | The address it listens on. Another one exposes the project's source and the app to whoever reaches it, and it warns so. |
| `--port <n>` | `8787` | The port; `0` picks a free one. |
| `--store <dir>` | `.sandburg/store` | The snapshot store, for `snapshot:<id>`. |

- **Not a Sandburg run.** No checks run, no network check, no `result.json`. The app's requests are
  your browser's: no egress allowlist applies ([Security](security.md)), and the app runs on the
  page's origin. Use `sandburg run` to test an app; `serve` is to look at one.
- **Your browser** must be a recent Chrome, Edge, Firefox or Safari, and the page a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): `localhost`
  is one over plain HTTP. For a remote machine, forward the port over SSH (above) rather than
  listening on another address; behind a reverse proxy, serve it over HTTPS.
- **The project's files** are read once, when it starts: restart `serve` for changes made outside the
  app. Packages install in the page on each load; nothing is cached on the host.
- It needs no Playwright, so it works with Sandburg installed alone. From a checkout, `npm run build`
  first (it serves `dist/browser-runtime`).
- It answers only requests for `localhost` and the other loopback names while it listens on a loopback
  address (any of 127.0.0.0/8, or ::1), so a
  page elsewhere cannot read the project through DNS rebinding.

## Exit codes

| Code | `run`, `open`, `batch`, `snapshot` | `compare` |
|---|---|---|
| `0` | Passed. | It has its report. |
| `1` | A blocking check failed (the app ran). In `batch`: a run failed. | |
| `2` | Error: the run did not reach the checks, or they did not finish in time, or its project or checks file did not load. In `batch`: a run ended in error. The browser could not be set up (Chromium missing, its sandbox could not start), or Sandburg itself failed: the error is printed. | Nothing could be compared: the reference judged no app, or every run of one side ended in error. |
| `64` | Usage error: an unknown command or option, a missing argument, an invalid value, no projects in the directory. | Same. |
| `129` | Interrupted (SIGHUP: the terminal closed), after closing the browser. | Interrupted (SIGHUP), after removing its containers. |
| `130` | Interrupted (Ctrl-C), after closing the browser. | Interrupted (Ctrl-C), after removing its containers. |
| `143` | Interrupted (SIGTERM), after closing the browser. | Interrupted (SIGTERM), after removing its containers. |
| `149` | Interrupted (Ctrl-Break on Windows), after closing the browser. | Interrupted (Ctrl-Break on Windows), after removing its containers. |

`serve` stops on Ctrl-C or SIGTERM, its way to end, with `0`; `2` when it could not start serving (the
project or the built browser runtime did not load, or the port was taken); `64` for a usage error. What
goes wrong in the page once it serves (a package that does not install, the app's dev server failing)
is shown in the page and does not change the exit code.

## Environment variables

| Variable | What it does |
|---|---|
| `SANDBURG_CHROMIUM=/path/to/chrome` | Use another Chromium instead of Playwright's. |
| `SANDBURG_NO_BROWSER_SANDBOX=1` | Run Chromium without its OS sandbox (`--browser-sandbox` overrides it). |
| `SANDBURG_EXTRA_CA_CERTS` (or `NODE_EXTRA_CA_CERTS`) | PEM bundle of extra CAs the browser trusts too, for networks that re-terminate TLS ([Security](security.md#networks-that-re-terminate-tls)). |
