# ADR 0005: WordPress Playground adapter and the per-sandbox egress proxy

- Status: Accepted (milestone 5)
- Date: 2026-09-29
- Partly supersedes ADR 0002, decision 3. For session contexts, the per-sandbox
  egress proxy replaces the dead-proxy backstop. The dead proxy remains the
  browser-wide default.

## Context

Milestone 5 tests whether the adapter pattern generalizes beyond JavaScript:
it should run a WordPress plugin task end to end in WordPress Playground (PHP
compiled to WebAssembly), with the same host, checks, classifier and results.

## Decision 1: The adapter drives Playground's own client and remote

- **Loading.** The browser half imports `startPlaygroundWeb` at run time
  from the Playground deployment that serves `remote.html`. Playground
  recommends this, because client and remote must match. It also keeps
  Playground's GPL-2.0-or-later code out of Sandburg's Apache-2.0 bundle.
  The deployment defaults to `https://playground.wordpress.net` and can be
  changed with `SANDBURG_PLAYGROUND_URL`.
- **Projects.** A project is a plugin (a root PHP file with a
  `Plugin Name:` header) or a theme (`style.css` with `Theme Name:`). Its
  framework is `wordpress`.
- **Lifecycle:**
  - *mount* boots Playground into the host's `#app` iframe, with PHP 8.3,
    the latest WordPress and an admin login, and writes the project into
    `wp-content/plugins/<slug>` or `wp-content/themes/<slug>`,
  - *install* activates the plugin (`activate_plugin`) or switches to the
    theme. A PHP fatal error or a `WP_Error` is `AdapterError('APP')`, so a
    broken plugin is an `app-bug` in the `install` phase,
  - *start* opens `/` and returns `navigate: false`, because the site is
    already rendering.
- **Contract additions** (they apply to any adapter):
  - `AdapterDescriptor.appFrameSelectors` locates the app frame nested in
    `#app`: Playground renders WordPress in `remote.html`'s `#wp`.
  - `StartResult.navigate: false` means the adapter loaded the frame itself.
  - `bundleDefines` lets an adapter pass build-time constants such as the
    Playground URL.
  - `CheckContext.appUrl(path)` resolves paths under the app's actual
    prefix: Playground's `/scope:…/`, almostnode Next.js's
    `/__virtual__/5173/`, `/` for Vite and Docker. So one checks file
    works everywhere.
- **Fixture.** `fixtures/wordpress-reading-time` is a "Reading Time" plugin
  with a `the_content` filter and a settings page (Settings API). Its checks
  open a post, see "1 min read", change "Words per minute" in wp-admin,
  save, and see "15 min read".

## Decision 2: A per-sandbox egress proxy for what routing cannot see

Playground registers a service worker on its own origin. Chromium fetches a
service worker's script without Playwright's request interception, so with
the ADR 0002 dead proxy, registration simply failed. The fix keeps
containment intact:

- **One proxy listener per run** (`src/orchestrator/egress-proxy.ts`), set
  as that browser context's proxy. The listening port identifies the
  sandbox. Proxy credentials would be neater, but Chromium does not send
  Playwright's proxy credentials with a service worker's script fetch.
- **Allowlist enforcement.** The proxy opens CONNECT tunnels only to that
  sandbox's allowlisted HTTPS origins, chaining through the host's own
  HTTPS proxy when one is configured. It refuses plain-HTTP proxying and
  every other origin, and records them in `network.blocked`. Tunneled
  connections are counted in `network.tunneled`. They are policed but not
  cached (TLS is end to end).
- **Unchanged parts.** Routed requests are still fulfilled from the cache,
  and requests to the sandbox origin bypass the proxy. The containment
  tests from ADR 0002 still pass: the canary sees zero connections. A unit
  test covers the proxy (an allowlisted tunnel works, others get a 403 and
  are recorded, plain HTTP is refused).
- **TLS-intercepting networks.** In networks that re-terminate TLS, a new
  `SessionOptions.extraCaCerts` (default: `$SANDBURG_EXTRA_CA_CERTS`, then
  `$NODE_EXTRA_CA_CERTS`) pins those CAs' public keys with Chromium's
  `--ignore-certificate-errors-spki-list`. That trusts exactly what Node
  already trusts; it does not disable verification.

Two bugs found along the way, both fixed:

- The tunnel's connect timeout was never cleared, so idle HTTP/2 tunnels
  died after 30 s.
- A socket handed over after the upstream CONNECT reply could drop bytes.

## Decision 3: Transient runtime failures are infra, and retried

`playground.wordpress.net` rate-limits repeated boots from one IP (HTTP
429). That showed up as broken downloads ("Could not unzip file… 960
bytes"), workers that failed to load, and failed service-worker
registrations. To make that visible and harmless:

- **Cache policy.** The gateway now caches only 2xx, 404 and 410. It never
  caches a 429 or a 5xx, which would replay forever, and never a redirect.
- **Fail fast.** During mount, install and start, a failed fetch of one of
  the runtime's own allowlisted assets, or a script that answered 429/5xx,
  fails the phase after 3 s instead of waiting out its deadline.
- **Classification.** New rules `signature:download-failed` and
  `runtime-boot-fetch` classify these as `infra`: the runtime could not
  load its own code, and no project code ran.
- **Retries.** `RunOptions.infraRetries` (default 1) re-runs an `infra`
  failure. The result lists the discarded attempts in `previousAttempts`,
  so flakiness stays visible in the data.
- **Opt-in test.** The WordPress end-to-end test is opt-in
  (`SANDBURG_E2E_WORDPRESS=1`), and it skips when Playground itself could
  not be loaded.

## Results

- **The plugin task passes end to end:** activation, the front-end filter,
  and a settings change in wp-admin that shows up on the front end. It took
  11.7–18.7 s per run across seven passing runs: Playground boot 6.5–11.5 s,
  activation about 0.1 s, checks 3.4–5.0 s. A sample result and screenshot
  are in `docs/evidence/`.
- WordPress phones home (Gravatar, update checks, the Playground CORS
  proxy). The gateway blocks all of it. The informational network check
  reports it, and the plugin's checks are unaffected.
- **Rate limits.** When the public Playground rate-limits this machine,
  runs fail as `infra` within seconds and are retried or skipped. They are
  never reported as plugin bugs. A plugin with a fatal error is classified
  `app-bug` in the `install` phase. That was verified by the classifier and
  the adapter code path, and the end-to-end variant ran when Playground was
  reachable.

## Consequences and follow-ups

- The adapter pattern generalizes: PHP/WordPress needed three small,
  general contract additions and no changes to checks, results or
  classification.
- For batches, self-host Playground and set `SANDBURG_PLAYGROUND_URL` to it.
  The public deployment is not meant for load. Most of Playground's traffic
  comes from its service worker and is tunneled rather than cached, so
  Sandburg's cache cannot shield the public server.
- Next steps: support a project `blueprint.json` (Playground's native
  setup format) for steps such as demo content or dependency plugins, and
  add a theme fixture.
