# ADR NNNN: Chromium's OS sandbox on by default, and site isolation

- Status: Accepted
- Date: 2026-10-26

## Context

ADR 0001 names three isolation boundaries for a run: its origin (between sandboxes), the network
policy (the egress gateway and proxy), and the browser's process sandbox (between the app and the
machine). The third was not in place. `Session.open()` launched Chromium through Playwright without
`chromiumSandbox`, and Playwright 1.64.1 then adds `--no-sandbox` (`_innerDefaultArgs` in
playwright-core's coreBundle: `if (options.chromiumSandbox !== true) chromeArguments.push("--no-sandbox")`).
The renderer that runs the app, the runtime's workers and the dev tools' WebAssembly ran outside
Chromium's OS sandbox.

Three other launch switches came under review:

- **Site isolation.** Chrome Headless Shell keeps a cross-site frame in its parent's renderer. Measured
  on Headless Shell 141 and on 156 (the build Playwright 1.64.1 pins): a page on `a.localhost` with a
  frame from `b.localhost` has no frame target of its own. With `--site-per-process` the frame is an
  out-of-process frame (a target of type `iframe`, in a renderer of its own). Each run is already a
  browser context of its own, so it never shares a renderer with another run.
- **`--enable-unsafe-swiftshader`** (Playwright adds it on Linux) lets web content fall back to
  SwiftShader, a CPU implementation of the GPU, where Chromium otherwise refuses it. On Headless Shell
  156, WebGL and WebGL 2 contexts work without it: same renderer string (ANGLE on SwiftShader's
  Vulkan), same pixels read back. No fixture or corpus app uses WebGL.
- **`--disable-popup-blocking`** (Playwright's too). The headless shell has no popup blocker: a
  script's `window.open`, with a user gesture or without, opens a page with the switch or without it
  (measured, 156). A popup opens in the run's own browser context, and its requests go through the
  run's egress proxy and routes like the page's (ADR 0030).

## Decision

- **The sandbox is on by default.** `launchOptions()` passes `chromiumSandbox: true`.
  `SessionOptions.browserSandbox: false`, the CLI's `--no-browser-sandbox`, or
  `SANDBURG_NO_BROWSER_SANDBOX=1` turns it off. The option wins over the environment, and only the
  value `1` turns it off (a typo leaves it on). `--browser-sandbox` asks for it even where the
  environment turns it off.
- **No automatic fallback.** Where the sandbox cannot start, `Session.open()` fails with a
  `BrowserSetupError` that says why and what to change: as root, Chromium refuses it; where
  unprivileged user namespaces are restricted (AppArmor on Ubuntu 23.10 and later), a sysctl or an
  AppArmor profile for the binary lifts that. It also names the three ways to turn the sandbox off.
  The CLI prints that message alone and exits 2. The error is recognised by Playwright's own message
  for it ("Chromium sandboxing failed!", which Playwright prints for Chromium's "No usable sandbox"
  and for crbug.com/638180, running as root).

  A fallback that retries without the sandbox and records it would keep runs going on such hosts.
  It would also turn a security default into one that degrades without anyone choosing it, on
  exactly the hosts (containers, CI runners) where runs go unwatched and a recorded field is easy to
  miss. The explicit opt-out costs one flag or one environment variable, once per host.
- **The choice is recorded.** Each `result.json` has `environment.browserSandbox` (required in
  result-schema.json), a batch's `summary.json` has `browserSandbox`, the CLI warns on stderr when a
  session starts without the sandbox, and a run's summary says so.
- **`--site-per-process`** is always passed.
- **`--enable-unsafe-swiftshader` is left out** (`ignoreDefaultArgs`). It gave runs nothing the
  headless shell does not already do.
- **`--disable-popup-blocking` stays.** It changes nothing in the headless shell. In a headed browser
  (`sandburg open`), popups stay confined to the run's context and policed like its page.

### Finding a run's renderer inside the sandbox

ADR 0046 finds a run's renderer by CPU time: the page reports its process's (`Performance.getMetrics`,
ProcessTime), the browser reports each renderer's by pid, and the renderer whose time brackets the
page's is the one. Inside the sandbox a renderer cannot read its own process's statistics:
ProcessTime is 0 (measured, 156), so the match picked an idle renderer (13 MB, against several
hundred for an app), and the e2e `run` and `batch` suites failed on `rendererPeakBytes`. ThreadTime
is counted only from `Performance.enable`, and the main threads of identical host pages differ too
little to tell them apart.

Inside the sandbox, the page works instead (`RendererMemorySource.mark`): each look, the host page
runs a 40 ms busy loop on its main thread. The host reads every renderer's main-thread CPU time from
`/proc/<pid>/task/<pid>/stat` (clock ticks of 10 ms) just before and just after. A renderer that used
at least 20 ms meanwhile fits. The looks narrow the renderers down as before, and stop once one is
left. Unsandboxed sessions keep the ProcessTime match. The cost is 40 ms of the host page's main
thread for each look until the renderer is found (looks are 250 ms apart from the start phase,
usually one or two). The batch suite's check that each of 10 runs, 8 at a time, found its own
renderer passed 3 runs out of 3 sandboxed.

### CI

GitHub's ubuntu runners can run the sandbox, but their image (ubuntu-24.04, 20261012.334) restricts
unprivileged user namespaces: `kernel.apparmor_restrict_unprivileged_userns` is 1, and Chrome for
Testing has no AppArmor profile that allows them. Each workflow job that starts Chromium first prints
the setting. If it is 1, the job sets it to 0, which keeps the sandbox on rather than opting out. No workflow uses `--no-browser-sandbox`.
`test/runtime/browser-sandbox.test.ts` launches Chromium with Sandburg's options and reads each
renderer's `Seccomp:` line in `/proc/<pid>/status` (2: a seccomp-bpf filter; 0 without the sandbox).
It also checks that a cross-site frame is a target of its own, and under `CI` it fails if the
sandbox was turned off.

## Measurements

`node scripts/bench.ts --base origin/main --head . --fixtures vite-react-counter --modes warm,cold
--rounds 5`, on a 4-core, 15 GB container:

| Head runs | Mode | main (no sandbox) | This change | Change |
|---|---|---|---|---|
| Sandboxed (as a non-root user) | warm | 1.24 s | 1.30 s | +5% |
| Sandboxed (as a non-root user) | cold | 5.08 s | 5.03 s | -1% |
| `SANDBURG_NO_BROWSER_SANDBOX=1` (site isolation only) | warm | 1.26 s | 1.24 s | -2% |
| `SANDBURG_NO_BROWSER_SANDBOX=1` (site isolation only) | cold | 4.95 s | 4.99 s | +1% |

`--site-per-process` costs nothing measurable for an app without cross-site frames. The sandbox
costs about 60 ms on a warm run (start +0.03 s, checks +0.02 s; the renderer's seccomp filter on
each system call, and the busy loops of the renderer match), within the noise of a cold run.

## Consequences

- Running as root, or where user namespaces are restricted, now needs a decision: change the host,
  or pass `--no-browser-sandbox` / `SANDBURG_NO_BROWSER_SANDBOX=1`. Docker images that run Sandburg as
  root need one or the other.
- A cross-site frame in an app costs a renderer process of its own.
- Results gain `environment.browserSandbox`, and batch summaries `browserSandbox`. Result
  `schemaVersion` stays 1: the field is added, and none changes.
- The renderer's memory, inside the sandbox, rests on `/proc` main-thread times and a short busy loop
  in the host page. Outside Linux, renderer memory was not read before either.
