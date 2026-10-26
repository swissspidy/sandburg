# ADR 0061: Chromium's OS sandbox on by default, and site isolation

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
  value `1` turns it off (a typo leaves it on, with a warning; `0` without one). `--browser-sandbox`
  asks for it even where the environment turns it off.
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
- **The choice is recorded.** Each `result.json` has `environment.browserSandbox` (optional in
  result-schema.json, so results written before it still validate; one without it ran without the
  sandbox), a batch's `summary.json` has `browserSandbox`, the CLI warns on stderr when a
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
hundred for an app), and the e2e `run` and `batch` suites failed on `rendererPeakBytes`.

Inside the sandbox the page's renderer can read its main thread's CPU time (ThreadTime, counted
from `Performance.enable`), and the host can read every renderer's main thread from
`/proc/<pid>/task/<pid>/schedstat` (its run time in nanoseconds), or from `/proc/<pid>/task/<pid>/stat`
(clock ticks of 10 ms) where the kernel keeps no scheduler statistics. For the page's renderer the
two differ by a constant: what its main thread used before the count started (measured: steady to
0.1 ms over a run). Each time the host reads the renderers, the page reads its ThreadTime just
before and just after, which bounds each renderer's offset to within that span and 3 ms either way
(15 ms with clock ticks: a tick, and one charged late). Over the run the page's renderer's bounds
overlap at every reading. Another renderer's part as soon as its main thread's use differs from the
page's by more than a few ms (about 30 ms with clock ticks). Between two readings of a look, the
page works on its main thread in an isolated world (`Page.createIsolatedWorld`, so the app cannot
change the clock the loop reads) until its ThreadTime has grown by an amount drawn between 30 and
90 ms, so that renderers part soon even beside pages doing the same. The work is bound by CPU time,
not wall time.

A renderer is taken once it alone fitted two looks. When none fits every reading, none is guessed:
the bounds start again from the next reading. After 8 looks without a renderer, the run reports no
renderer memory. Unsandboxed sessions keep the ProcessTime match.

A first version spun for 40 ms of wall time and took any renderer whose main thread used 20 ms in
that time. Under load (8 sandboxed pages on 4 busy cores), a page's renderer could get less CPU than
that and drop out, and another page's renderer was taken in its place: 1 to 2 of 8 pages were wrong
in each round of an independent review. A second version, bound by CPU time but comparing each
look's growth on its own, took no wrong renderer. But in the batch e2e suite, which starts 8 tabs
together, several renderers grew alike in every look (other apps' main threads working as much in
the same span), and a run often ended before two looks agreed (one run in 10 without its renderer
memory, in each of 3 runs of the suite). A third version, this one with clock ticks (`stat`), took no
wrong renderer in 218 pages of an independent review. But tabs opened together start within 10 to
40 ms of each other's offsets, and with bounds at least 30 ms wide, the batch e2e suite still had a
run without its renderer memory in 8 of 10 runs: the offsets parted too slowly for a warm run of a
second or two. Run time in nanoseconds (`schedstat`) narrows the bounds to a few ms.

`test/runtime/renderer-memory.test.ts` holds 8 pages, each with 48 MB more memory than the one
before, while every core is busy. Its first test has the pages look a little apart, and checks that
a page's renderer, when one is taken, holds that page's memory: the first version failed it in 1 of
3 runs. Its second has them opened together, each with an app at work on its main thread, and
looking in step for 2 s: every page must find its own renderer. The third version (clock ticks)
failed it in 2 of 4 runs; this one passed 6 of 6. The batch e2e suite (10 runs, 8 at a time, each
run's renderer found) passed 10 runs in a row sandboxed.

The cost inside the sandbox is the work. The app's frame is same-origin with the host page and
shares its main thread, so each look blocks the app for 30 to 90 ms of CPU. Looks are 250 ms apart
from the start phase until the renderer is found: usually two, 8 at most (720 ms of CPU at most).

### CI

GitHub's ubuntu runners can run the sandbox, but their image (ubuntu-24.04, 20261012.334) restricts
unprivileged user namespaces: `kernel.apparmor_restrict_unprivileged_userns` is 1, and Chrome for
Testing has no AppArmor profile that allows them. Each workflow job that starts Chromium first prints
the setting. If it is 1, the job sets it to 0, which keeps the sandbox on rather than opting out. No workflow uses `--no-browser-sandbox`.
`test/runtime/browser-sandbox.test.ts` launches Chromium with Sandburg's options and reads each
renderer's `/proc/<pid>/status`. Sandboxed, a renderer has a seccomp-bpf filter (`Seccomp: 2`) and
pid namespaces of its own under the browser's (more entries in `NSpid:`). Without the sandbox it has
what the test process has (a container's seccomp profile, if any) and the browser's namespaces.
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
