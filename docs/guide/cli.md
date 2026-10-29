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

```sh
sandburg run <project> [--checks checks.spec.ts]
sandburg batch <dir> [--parallel 8]                     # each subdirectory, .zip or .json in <dir> is a project
sandburg compare <dir> --reference docker [--report path]
sandburg snapshot <project>                             # store it, print its snapshot id
sandburg open <project>                                 # load it in a visible tab
```

## Project inputs

`<project>` is one of:

- a **directory**;
- a **`.zip`** (a single top-level folder is stripped);
- a **JSON file tree**: `{ "path": "contents" }`;
- **`snapshot:<id>`**, or a prefix of the id, from the snapshot store.

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
sandburg run snapshot:3f9a1c        # runs it again, from the store
sandburg open snapshot:3f9a1c       # looks at it in a visible tab
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
| `--no-longest-first` | | `batch`: start the projects in the order found (by name). By default a batch starts first those whose checks, then whole runs, took longest in its earlier batches (`.sandburg/batches`), which shortens its wall time; the order then differs from batch to batch, and so does what each app runs beside. Use this to compare two batches' per-app times. |
| `--out <dir>` | `.sandburg/runs` | Results directory. |
| `--cache <dir>` | `.sandburg/cache` | HTTP cache directory. |
| `--store <dir>` | `.sandburg/store` | Snapshot store directory. |
| `--offline` | | Serve only from the cache; never fetch upstream. See [below](#--offline). |
| `--ready <selector>` | | Wait for this selector before running checks. |
| `--save-files <regex>` | | `run`, with a project directory: write the app's matching files back. See [below](#--save-files). |
| `--headed` | | Show the browser window (`open` always does). |
| `--no-browser-sandbox` | sandboxed | Run Chromium without its OS sandbox, only for hosts where it cannot start (as root, or user namespaces restricted). Also `SANDBURG_NO_BROWSER_SANDBOX=1`. Results record it. See [Troubleshooting](troubleshooting.md#the-browser-sandbox). |
| `--browser-sandbox` | | Run it sandboxed even where `SANDBURG_NO_BROWSER_SANDBOX=1` is set. |
| `--json` | | Print the full JSON result (`run`) or batch summary (`batch`) instead of a summary. |
| `--reference <name>` | `docker` | `compare`: the reference runtime (`docker`, the default and only one). |
| `--report <path>` | `.sandburg/reports/fidelity` | `compare`: write the report to `<path>.md` and `<path>.json`. |
| `-h`, `--help` | | Show the help. |

### `--offline`

`--offline` answers every request from the HTTP cache (`.sandburg/cache`) and fails on a miss. Run the
project once online to fill the cache, then run it offline as often as you like. A miss is an `infra`
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

## Exit codes

| Code | `run`, `open`, `batch`, `snapshot` | `compare` |
|---|---|---|
| `0` | Passed. | It has its report. |
| `1` | A blocking check failed (the app ran). In `batch`: a run failed. | |
| `2` | Error: the run did not reach the checks, or they did not finish in time, or its project or checks file did not load. In `batch`: a run ended in error. The browser could not be set up (Chromium missing, its sandbox could not start). | Nothing could be compared: the reference judged no app, or every run of one side ended in error. |
| `64` | Usage error: an unknown command or option, a missing argument, an invalid value, no projects in the directory. | Same. |
| `129` | Interrupted (SIGHUP: the terminal closed), after closing the browser. | Interrupted (SIGHUP), after removing its containers. |
| `130` | Interrupted (Ctrl-C), after closing the browser. | Interrupted (Ctrl-C), after removing its containers. |
| `143` | Interrupted (SIGTERM), after closing the browser. | Interrupted (SIGTERM), after removing its containers. |
| `149` | Interrupted (Ctrl-Break on Windows), after closing the browser. | Interrupted (Ctrl-Break on Windows), after removing its containers. |

## Environment variables

| Variable | What it does |
|---|---|
| `SANDBURG_CHROMIUM=/path/to/chrome` | Use another Chromium instead of Playwright's. |
| `SANDBURG_NO_BROWSER_SANDBOX=1` | Run Chromium without its OS sandbox (`--browser-sandbox` overrides it). |
| `SANDBURG_EXTRA_CA_CERTS` (or `NODE_EXTRA_CA_CERTS`) | PEM bundle of extra CAs the browser trusts too, for networks that re-terminate TLS ([Security](security.md#networks-that-re-terminate-tls)). |
