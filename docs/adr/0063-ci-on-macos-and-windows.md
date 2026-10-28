# ADR 0063: CI on macOS and Windows

- Status: Accepted
- Date: 2026-10-28

## Context

Every CI job (ADR 0062) ran on `ubuntu-latest`. Most people who try Sandburg do so on macOS, and the
host has code for other systems that no job ran: the Windows path checks in
`src/orchestrator/app-files.ts`, the renames retried while a file is busy, the Linux-only memory and
renderer readings (`memory.ts`, `renderer-memory.ts`), and Chromium's sandbox, which is on by default
(ADR 0061) and which macOS and Windows provide without the user-namespace setup Linux needs.

A first run on `macos-latest` and `windows-latest` (CI run 40633063216) failed 4 unit tests on macOS
and 25 on Windows, and every e2e `run` test on Windows.

## Decision

- **A `platforms` job on `macos-latest` and `windows-latest`** (ci.yml): typecheck, the unit suite,
  the runtime suite in Chromium, and the e2e `run` file (the Vite + React fixture with its checks, the
  network policy, ready and checks deadlines). The whole e2e matrix, lint, the packed package and the
  Docker reference stay on Linux only: lint and the bundles are the same everywhere, the reference
  needs Docker, and twelve more jobs per OS would multiply CI minutes (GitHub bills a macOS
  minute at ten Linux minutes, a Windows one at two, for private repositories) for code paths the
  `run` file already takes. Each suite runs whatever the one before
  it did, so one job shows every failure; a test that hangs in the e2e step fails at 5 min.
- **The browser sandbox stays on** on both: no `SANDBURG_NO_BROWSER_SANDBOX`. The
  `browser-sandbox` runtime test checks Linux's namespaces, and is skipped elsewhere, as it was.
- **`setup-chromium` works on the three OSes**: the AppArmor step and apt (`install-deps`) only on
  Linux; the browser cache at Playwright's directory for the OS (`~/.cache/ms-playwright`,
  `~/Library/Caches/ms-playwright`, `~/AppData/Local/ms-playwright`), keyed as before on the OS.
- **The jobs' steps run in bash** (Git Bash on Windows), as the Linux jobs' do.
- **`.gitattributes` checks text out with LF** on every OS: Git for Windows converts to CRLF by
  default, and the generated docs, the API report and the fixtures are compared byte for byte.

### What the jobs found

- **npm could not be started on Windows.** `npm` is `npm.cmd` there, a batch file, which Node spawns
  only through a shell (CVE-2024-27980): every install failed with `spawn npm ENOENT`. npm is now
  spawned as its `npm-cli.js` on the running Node (`src/adapters/node/npm-cli.ts`), and the
  in-process resolver, which had no npm to load on Windows, finds it the same way.
- **The resolver wrote a wrong lockfile through a symlink.** Arborist was given the install
  directory as named; npm's CLI gives it its working directory, a real path. Through a link
  (macOS's `/var` is `/private/var`, where its temporary directory is) the lockfile named the
  packages `../../private/var/.../node_modules/app` and the root a `file:` link. It now gets the
  real path.
- **A batch on macOS opened one app at a time** (the batch test's, with `parallel: 2`, on the macOS
  runner): its memory guard reads `os.freemem()`, which there counts the free pages only, and macOS
  keeps those low by caching files in the rest. The test now gives the batch memory to spare, as the
  file's other batch tests do, since it checks parallelism, not the machine. Available memory on macOS is now free
  plus inactive pages (`vm_stat`), as psutil counts it. `memory.ts` joins the reviewed list of host
  files that start a process (`.oxlintrc.json`): it runs `vm_stat`, with no arguments, on macOS.
- **A preload list could lose another process's entries on Windows.** There a rename over a file
  that another handle has open fails (EPERM, EACCES, EBUSY), and the list's write, from a timer,
  dropped the error and what this process had recorded. It is retried as the app files' rename
  already was (`renameRetrying`, now in `src/rename-retrying.ts`); so is the preload bundle's.
- **`npm run build`** removed `dist/` with `rm -rf`, which cmd.exe does not have.
- **Scripts and tests**: the architecture rules and the API report named modules with `\`; a
  script found the repository from a URL's pathname, and a test imported a path with a drive letter.

Tests that check something Windows does not have say so in their skip or their condition: POSIX
user ids (the Docker reference as a user other than root), executable bits (npm's bin links in the
package store), the error code for a name over 255 characters (Windows reports ENOENT). The esbuild
shim's test answers esbuild-wasm's probe for `C:\` as the runtime's file system does: the shim runs
only there, and on a Windows host the probe made esbuild-wasm refuse its browser build's `/`.

## Consequences

- A change that breaks the host on macOS or Windows fails CI on its pull request. In CI run
  40638479873 the macOS job took 3 min 2 s and the Windows one 4 min 41 s (the e2e `run` file:
  1 min 8 s and 2 min 41 s), beside the Linux jobs.
- A failure in the other e2e files (frameworks, batch, websockets, ...) on macOS or Windows shows only
  when someone runs them there.
