# ADR 0003: Next.js support, the Nodebox adapter, and what the runtimes need patched

- Status: Accepted (milestone 3)
- Date: 2026-09-29

## Context

Milestone 3 asks for Next.js support in the almostnode and Nodebox adapters,
with failure classification. Generated Next.js apps today mostly look like
`create-next-app` 15: App Router, React 19, a root layout that renders
`<html><body>`, client components, and route handlers that import
`NextResponse` from `next/server`. The fixture `fixtures/next-app-router`
has all of these.

## Decision 1: almostnode runs Next.js through its NextDevServer, patched by the adapter

almostnode's `NextDevServer` renders App Router pages on the client, runs
route handlers in the browser, and rewrites bare imports to esm.sh. Getting
the fixture to pass took five fixes. Each one is a fidelity problem that
generated apps hit, so each is documented here and marked in the code:

1. **React version.** almostnode hard-codes React 18.2.0 twice: in its page
   import map, and as literal esm.sh URLs that its code transform writes
   into every module (`EXPLICIT_MAPPINGS`). Those URLs beat any import map.
   The adapter rewrites the hard-coded URLs in served JS and HTML back to
   bare specifiers (`unpinReact`). It then adds the project's React to the
   import map, including the exact `react-dom/client` and
   `react/jsx-runtime` keys, which beat prefix keys. Without this, a React
   19 app loads two Reacts and crashes ("Objects are not valid as a React
   child", React error 525).
2. **Document elements.** almostnode renders the whole tree, root layout
   included, into `div#__next`. React 18 tolerated `<html><body>` nested in
   a div. React 19 treats them as singletons bound to the real document
   elements, and its event dispatch then loops forever: every focus or key
   press hung the tab. We found it by pausing the hung page over CDP. For
   Next.js, the import map points `react/jsx-runtime` at a small wrapper
   (`documentElementsRuntime`). The wrapper turns `html`, `head` and `body`
   into components that apply their attributes (`lang`, `className`) to the
   real elements and render only their children, so body classes (for
   example Tailwind's) also land where `next dev` puts them.
3. **`next/server`.** Route handlers `require('next/server')`, which
   almostnode does not provide. The adapter writes a minimal shim
   (`NextResponse.json/redirect/next/rewrite`, `NextRequest.nextUrl`,
   `after`) into the virtual FS. It records the shim in the new
   `install.shims` result field, because a shim is a fidelity risk the
   study should be able to split on.
4. **Development builds.** The import map now uses esm.sh's `?dev` builds,
   as `vite` and `next dev` serve development React. The errors are
   readable and the warnings are the same.
5. **Redirects in the gateway.** The Tailwind CDN that NextDevServer
   injects answers with a 302. Playwright does not intercept the follow-up
   request of a redirect that was fulfilled from a route. That request went
   to the network, and the dead-proxy backstop from ADR 0002 caught it. The
   gateway now follows redirects itself, checking every hop against the
   allowlist, and serves the final response. The backstop caught a real
   escape path. That is the point of having it.

Items 1 and 2 are upstream bugs in almostnode 0.2.14 and are worth
reporting. The adapter's patches are small string-level rewrites that fail
safe: when almostnode changes, the rewrite no-ops, and the React 19 checks
start failing.

Result: the fixture passes on almostnode in 2.1 s warm, with its three
functional checks (an API route, state updates and a form). A broken
route handler is classified `app-bug` while the rest of the app keeps
passing.

## Decision 2: Nodebox is an optional adapter, and today it cannot run current stacks

- **License.** `@codesandbox/nodebox` uses the Sustainable Use License
  (internal or non-commercial use only; not OSI). Sandburg does not depend
  on it. The adapter loads only if the user installs the package
  (`npm install --no-save @codesandbox/nodebox`), and otherwise fails with
  an explanation. The runtime itself is served from
  `nodebox-runtime.codesandbox.io`, so Sandburg cannot self-host it either.
- **Egress.** The adapter needs `nodebox-runtime.codesandbox.io`,
  `*.codesandbox.io` (previews and the package CDN), `*.csb.app`, and
  `registry.npmjs.org`. The gateway's allowlist gained wildcard origins
  (`https://*.codesandbox.io` matches subdomains, never the apex, other
  schemes or other ports). The npm registry is served through the same
  cache: this is the "npm mirror" of milestone 2 in practice. Telemetry
  (Cloudflare Insights, challenge POSTs) stays blocked. The runtime works
  without it.
- **Mechanics.** Nodebox has no `npm` binary, so the adapter runs the
  `dev` or `start` script's command line directly (for example `next dev`),
  as Nodebox's docs do. It fails as soon as the process exits, rather than
  waiting out the preview timeout.
- **Findings.** Nodebox 0.1.9 emulates Node.js 16.15.1:
  - Next.js 15 fails on the missing built-in `dns/promises`.
  - Next.js 14 refuses to start (it needs Node.js 18.17).
  - Next.js 13.5 fails with "Initializing node worker failed".
  - Vite 4 fails because Nodebox maps `esbuild` to an `esbuild-wasm`
    package that it then cannot find.

  The probe now rejects `next@>=14` up front, and each other case has a
  classification signature, so all of them come out as
  `runtime-unsupported` with a named rule. For the fidelity study, Nodebox
  is a negative result: on current generated apps it would be a pre-filter
  that rejects almost everything.

## Decision 3: New classification signatures

| Rule | Matches |
|---|---|
| `signature:missing-builtin` | `Cannot find module '<Node.js built-in>'` (only built-ins, not app packages) |
| `signature:node-version` | "Node.js version >= X is required" |
| `signature:runtime-worker` | "Initializing node worker failed" |
| `signature:esbuild-wasm` | now also `Cannot find module 'esbuild-wasm'` |

A failed `dispose` no longer decides a run's class. A tab that hung during
checks used to be reported as a dispose timeout.

## Consequences

- Next.js and Vite apps both run on almostnode. What they don't cover
  shows up in the results: shims used, dependency resolution, and
  signature-named failures.
- Server components with server-only code (databases, `fs`,
  `next/headers`) are still out of reach for almostnode's client-side
  rendering. The fidelity study will measure how often generated apps need
  them.
