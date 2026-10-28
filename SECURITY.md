# Security policy

Sandburg runs code it does not trust: generated apps, their dependencies and their dev scripts. Keeping
that code inside its sandbox is one of the project's core claims, so reports of a way out are welcome.
The security model is in the README's [Security](README.md#security) section and in
[ADR 0001](docs/adr/0001-runtime-adapters-serving-results.md) (isolation boundaries),
[ADR 0040](docs/adr/0040-security-fixes.md) and [ADR 0054](docs/adr/0054-security-review-round-4.md)
(the security reviews and the boundary map) and [ADR 0061](docs/adr/0061-chromium-sandbox.md)
(Chromium's OS sandbox and site isolation).

## Supported versions

Security fixes go into the latest minor release on npm (Sandburg is 0.x, so that is the latest
`0.y` line). Older minors get no fixes: upgrade to the latest one.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: on the repository's
**Security** tab, choose **Report a vulnerability**
([direct link](https://github.com/swissspidy/sandburg/security/advisories/new)). Please do not open a
public issue, pull request or discussion for it.

Include what you can of:

- the Sandburg version (`npm ls sandburg`, or the commit), Node.js version and OS;
- the command or `Session` options you ran, including whether `--checks-in page`, `--install-in browser`
  or `--save-files` was used;
- a minimal project (and checks file) that shows the crossing, and what it reaches that it should not;
- the run's `result.json`, in particular `environment.browserSandbox`.

As ADR 0054 records, a boundary that can be crossed is fixed first, with a neutral commit message, and
described once the fix is released. You will be credited in the advisory unless you ask not to be.

## Response

This is a project maintained by one person. Reports are handled on a best-effort basis: there is no
guaranteed response or fix time. Replies and progress go in the private advisory.

## Scope

Sandburg's default configuration is what counts: Chromium's OS sandbox on, checks files run by the host
only when you passed them yourself.

In scope:

- **Sandbox escape.** An app, its packages or its dev script running code outside its sandbox tab:
  on the host's Node.js process, in another sandbox's origin or tab, or outside Chromium's renderer
  sandbox.
- **Egress-allowlist bypass.** An app reaching the network other than through the egress gateway and
  its sandbox's egress proxy, or reaching an origin its allowlist does not name (including the host's
  own loopback services, beyond the host server's routes for that sandbox).
- **`--save-files` writes outside the project.** A path an app chooses that makes `run --save-files`
  (or `collectFiles`/`onAppFiles`) write outside the project directory, through a symlink, or into
  `node_modules`, `.git` or a dot directory.
- **Host file access from an app.** An app reading or writing files on the host other than the
  installed packages and caches the host serves it: through the host server's routes, the file channel,
  the package store, the caches shared across runs, or the installer (a dependency spec that makes the
  host clone, fetch or read something other than a registry package).
- **Checks with host privileges under `--checks-in page`.** A checks file run with `--checks-in page`
  getting anything of the host process: importing a module, running code in Node.js, or reaching what
  the host can reach.
- Crashing or hanging the host process from an app (the host's parsers of app-controlled input), or one
  sandbox reading or poisoning another's cached data.

Out of scope:

- **The Docker reference** (`compare --reference docker`, `dockerReference()`). It runs a project's
  install scripts and dev script with real npm in a container and is documented as **not a security
  boundary** ([ADR 0004](docs/adr/0004-docker-reference-and-fidelity-study.md)): use it only on
  projects you trust.
- **Running without the browser sandbox** (`--no-browser-sandbox`, `SANDBURG_NO_BROWSER_SANDBOX=1`,
  `browserSandbox: false`). That turns off the boundary between the app and the machine; a renderer
  exploit that only works there is not a Sandburg vulnerability.
- **Checks files run on the host** (`--checks` without `--checks-in page`). They are imported by
  Sandburg's Node.js process and are trusted code: they can do anything a program on the machine can.
- Bugs in Chromium, V8 or Node.js themselves (report them upstream), unless Sandburg's configuration
  makes them reachable where they would not be otherwise.
- The limits ADR 0040 ("Not fixed") and ADR 0054 ("Decisions on resource fairness") accept: reads of
  a cache by a key the reader already knows, preload lists, and one sandbox's compiles slowing its
  siblings in a batch.
