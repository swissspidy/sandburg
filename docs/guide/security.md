# Security

Sandburg runs code nobody has reviewed: generated apps, their dependencies, and checks a coding agent
wrote. This page says what holds that code in and what you have to provide. To report a vulnerability,
see the [security policy](../../SECURITY.md).

## The layers

An app runs in a tab of its own: its own browser context and origin, every request through the
egress gateway and the sandbox's egress proxy (the allowlist). Under that, Chromium runs inside its
OS sandbox (on Linux: namespaces and a seccomp-bpf filter for each renderer), and with
`--site-per-process` a frame of another site gets a renderer process of its own
([ADR 0061](../adr/0061-chromium-sandbox.md)).

## The egress model

A sandbox reaches the network only through a caching gateway and a per-sandbox allowlist, and tests
prove it ([ADR 0001](../adr/0001-runtime-adapters-serving-results.md),
[ADR 0002](../adr/0002-snapshots-and-batches.md), [ADR 0005](../adr/0005-wordpress-playground.md)):

- **Its own origin.** Each sandbox is a `*.sandburg.localhost` origin. The host server refuses
  cross-site requests (`Sec-Fetch-Site`) and unknown sandboxes; the runtime's file channel accepts
  only the sandbox's own origin.
- **The egress gateway** intercepts the context's HTTPS, answers allowlisted origins from a shared
  disk cache or upstream, and blocks the rest. The node runtime's allowlist is the npm registry and
  Google Fonts ([`src/adapters/node/index.ts`](../../src/adapters/node/index.ts)). A blocked request is
  reported in `result.json` (`network.blocked`) and does not fail the run on its own.
- **The egress proxy** is the context's proxy for what the gateway cannot see. It refuses plain HTTP
  and, for intercepted contexts, every tunnel.
- **`--offline`** answers every request from the cache and fails on a miss.
- **Installs.** The host runs npm with `--ignore-scripts`, and installs registry dependencies only: a
  git, directory, URL, `file:`, `link:` or `workspace:` dependency fails the install as unsupported,
  also when a registry package pulls one in. A lockfile's tarball URLs must be on npm's registry.
- **Caches shared across runs** take writes only with the run's capability token, from its own
  sandbox ([ADR 0040](../adr/0040-security-fixes.md)).

[ADR 0054](../adr/0054-security-review-round-4.md) maps every boundary an app can reach and how the
host holds it, with the tests that check each one.

## The browser sandbox

The sandbox needs a host that allows it. On Linux it needs unprivileged user namespaces, which
Chromium does not use as root, and which Ubuntu 23.10 and later restrict with AppArmor
(`sysctl kernel.apparmor_restrict_unprivileged_userns=0` lifts that, as does an AppArmor profile for
the Chromium binary). Where the sandbox cannot start, `sandburg` stops before the first run and says
what to change. It does not fall back on its own. To run without the sandbox, say so:
`--no-browser-sandbox`, `SANDBURG_NO_BROWSER_SANDBOX=1`, or `new Session({ browserSandbox: false })`
(`--browser-sandbox` asks for the sandbox where the environment variable turns it off).
The CLI warns, and each `result.json` (`environment.browserSandbox`) and batch `summary.json`
(`browserSandbox`) records it.

How to fix a host where it does not start is in [Troubleshooting](troubleshooting.md#the-browser-sandbox).

## Checks files

A checks file is imported by Sandburg's Node process: it can do anything a program on this machine
can. For checks someone else wrote (a coding agent), `--checks-in page` runs the file's code in the
sandbox tab instead: the host only reads it and strips its types, and the checks can do no more than
the app's own code ([ADR 0023](../adr/0023-checks-in-the-page.md),
[Agents and CI](agents-and-ci.md#the---checks-in-page-trust-model)).

## The Docker reference

`sandburg compare --reference docker` runs `npm install` with the dependencies' lifecycle scripts and
`npm run dev` with the project's own code in a Docker container, with the project directory mounted.
**The Docker reference is not a security boundary**: use it only on projects you trust. When the host's
proxy listens on its loopback only, the container shares the host's network and can reach every service
on it ([ADR 0004](../adr/0004-docker-reference-and-fidelity-study.md)).

## Networks that re-terminate TLS

On networks that re-terminate TLS, Sandburg trusts the CAs in `$SANDBURG_EXTRA_CA_CERTS` (or
`$NODE_EXTRA_CA_CERTS`) in the browser too, by pinning their public keys. Certificate verification
stays on: only chains containing one of these keys are accepted in addition to the normal trust store
(`extraCaCerts` in `SessionOptions`).
