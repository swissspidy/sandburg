# ADR 0075: `sandburg serve`: a project in your own browser, outside the sandbox

- Status: Accepted
- Date: 2026-11-26

## Context

Issue [#167](https://github.com/swissspidy/sandburg/issues/167), part 2: `sandburg open` launches a headed
Playwright Chromium on the machine that runs Sandburg. On a headless workstation, a container or a remote
dev box reached over SSH, there is no window to show, and nobody can click through the app.

`open` cannot simply skip launching the browser. A run's host page is driven by the session through
Playwright (`page.evaluate`), and the sandbox's network is enforced in that browser: Playwright's routes
(the egress gateway) and the per-context proxy. In another browser there is neither a driver nor a
network boundary. ADR 0074 shipped the browser runtime, which needs neither: the demo site's generator
installs packages from the npm registry and compiles in the page.

## Decision

**`sandburg serve <project>` serves the project for your own browser, on the browser runtime.**

- `src/serve.ts` is a small HTTP server: `/` is a page, `/sandburg/` the package's prebuilt
  `dist/browser-runtime`, `/sandburg-serve/project.json` the project as loaded by `loadProject` (a
  directory, a zip, a JSON tree or a snapshot). The page makes itself cross-origin isolated (`isolate()`),
  loads the host, and runs the project as a run does: mount, install (`pageInstall`, in the page), start,
  ready. The app lives at `/app` and sees itself at `/`; the page shows its status, the app's address and
  errors.
- **No Playwright.** `bin/sandburg.js` loads `serve`'s module on its own, before the CLI's (which
  imports Playwright), so it works with the package installed alone. The CLI's `main()` passes `serve` to
  it too.
- **Outside the sandbox, by choosing the command.** No egress gateway or allowlist (the app's requests are
  the browser's), the app on the page's origin, no checks, no network check, no result. The command
  says so as it starts, and the CLI guide, the security guide and SECURITY.md say so ("out of scope").
  It is not a flag of `run` or `open`, so a run's guarantees never quietly change.
- **127.0.0.1 by default.** `--host` listens elsewhere, with a warning: whoever reaches it gets the
  project's source and runs its app, and browsers need HTTPS or localhost for the service worker and
  shared memory. Forwarding the port over SSH keeps it on localhost and needs nothing else.
- **No DNS rebinding.** While it listens on a loopback address, it answers only requests whose `Host` is a
  loopback name (`localhost`, `127.0.0.1`, `[::1]`): a page on another site that points its own name at
  127.0.0.1 gets 403, not the project. Listening on another address, it answers any name (a reverse proxy
  or a LAN name), which `--host` is the choice of.
- `serve` creates an HTTP server of its own beside the host's one-server rule (`sandburg/one-host-server`,
  ADR 0056): it is not a Sandburg host (no session, no sandbox, no caches), and runs alone.

## Consequences

- A remote or headless machine can show an app: `sandburg serve ./app` there, `ssh -L 8787:localhost:8787`
  here, and `http://localhost:8787/` in a local browser.
- The project's files are read once; changes made outside the app need a restart (a watch mode can come
  later). Packages install in the page on each load, from the npm registry: nothing is cached on the host,
  and an offline machine cannot serve a project with packages.
- Git dependencies and other host-side install features (ADR 0073) are not available: the page installs
  registry packages only, as `--install-in browser` does.
- Exit code `0` when stopped with Ctrl-C or SIGTERM (its way to end), `2` when the project or the browser
  runtime did not load or the port was taken, `64` for a usage error.

## Tests

- `test/unit/serve.test.ts`: the server answers the page, the project and the runtime's files (the
  service worker allowed at `/`), nothing outside the runtime's directory; with a loopback address, only
  loopback host names (403 for others); a missing runtime says to build it; usage errors exit 64, a project
  that does not load exits 2.
- `test/runtime/serve.test.ts`: in Chromium, the served page becomes cross-origin isolated, installs and
  starts a Node server project, and shows the app, which sees itself at `/` and reaches its server.
- `test/pack/install.test.ts`: installed without Playwright, `sandburg serve --help` works.
