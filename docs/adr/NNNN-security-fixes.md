# ADR NNNN: Security fixes: the egress proxy's parser, cache writes, request bodies, lockfile locations, errors

- Status: Accepted
- Date: 2026-10-25

## Context

Sandburg runs untrusted, generated apps. What a run's app controls is its page (and the runtime's
threads, same origin): it can make any request the browser lets it make, to its own origin's host
routes (`/__sandburg/*`, ADR 0001), through the egress gateway and its context's egress proxy (ADRs
0005, 0030). The host process (orchestrator, host server, gateway, caches) must hold against all of
it: one app must not end other runs, change what another run starts from, or reach the host's files
and memory. A test session found five ways it did not, all reproduced on main:

- **F1 (high), one request ended the host process.** The egress proxy split a CONNECT target on `:`;
  for an IPv6 literal (`[::1]:443`) the host was `[`, and the origin matcher parsed `https://[` with
  `new URL`, which throws, in the proxy's `connect` handler. Nothing caught it: the host process exited
  and every run of the session or batch with it. A page reaches the proxy with
  `window.open('https://[::1]/')`: a popup's first request goes to its context's proxy (ADR 0030).
  `CONNECT host:0443` was also taken as port 443. The host server's WebSocket upgrade handler had the
  same fault (`new URL` of the request target `//[`), and a failure after a response's headers went
  out threw in its error handler.
- **F2 (high), an app could write the shared Next.js and Vite seed caches.** A seed's key is a digest
  of public inputs (the pinned versions, the router, `NODE_VERSION`, `TRANSFORM_VERSION`). It was
  issued when its seed run installed, and the host took the first write under it from any sandbox
  (it could not tell runs apart), until the seed run's own write at its end. The first Next.js app
  with a set of versions runs beside its own seed run: its page posted a cache under the seed's key
  on the first try, the seed run's write was then refused, and every later app with those versions
  would start from the planted webpack cache (`fixtures/next-pages-router`). The existing test only
  posted after the seed was stored. The compile cache (ADR 0033) took records under any issued
  dev-cache key the same way.
- **F3 (medium), request bodies were not bounded.** `HostServer` buffered a body whole before the
  adapter saw it. `/__sandburg/compile` and `/__sandburg/tla-scan` took any size; the dev-cache route
  checked its 256 MB limit only after buffering, for keys it then refused too. A page could post a
  large Blob and grow the host's memory. So could many blocked requests with long URLs: the gateway
  and the proxy kept every one in the run's `network.blocked` and `network.failed`.
- **F5 (low, defence in depth), lockfile locations.** The package store (ADR 0032) placed a
  lockfile's packages at any location starting with `node_modules/`: `node_modules/../../x` linked
  files outside the install directory. npm drops such entries when it writes a lockfile, so this was
  one layer of two.
- **F4 (minor), errors to the page.** A 500 from the host server carried the error's stack: the
  checkout's and the home directory's paths, and the message.

## Decision

- **F1: CONNECT targets are parsed strictly** (`parseConnectTarget`, `src/orchestrator/egress-proxy.ts`):
  the authority form of RFC 9110, a DNS name (labels of letters, digits, `-` and `_`, 1-63 characters,
  253 in all) or an IPv6 literal in brackets (no zone id), a colon, and a decimal port 1-65535 without
  sign or leading zeros; at most 261 characters. Anything else gets a 400 and is recorded as blocked
  ("malformed CONNECT target"). An IPv6 tunnel is policed by its origin (`https://[::1]`) as any other.
  **No connection's fault reaches the process**: the proxy's `connect` handler and the host server's
  `upgrade` handler catch and close that connection; the origin matcher matches nothing for an origin
  that is not a URL (`URL.parse`); the gateway's routed handler fails a request it cannot answer; the
  host server answers a request target it cannot parse with a 400, and ends the connection when a
  response fails after its headers.
- **F2: a cache write needs the run's own capability, from its own sandbox**
  (`src/adapters/node/index.ts`). `hostInstall` issues the run a random 256-bit token
  (`randomBytes(32)`) for each write it may make: one for its dev-server cache under its key (a seed
  run's, under the seed's key), and one for recording compiles under its dev-cache key. The tokens
  reach only that run's page, in its install data (the worker gets the compile token with
  `compileCache`). The session tells the install which sandbox the run's page is in once its tab is
  taken (`HostInstallOptions.sandbox`, a promise), and each token is bound to it. The host server
  passes each request's sandbox (from its `Host`, which is its origin) and headers to the adapter
  (`HostRequest.sandbox`, `headers`). The dev-cache route stores a cache only for a request that
  carries the token (`x-sandburg-token`) issued for that key, from that sandbox; the token takes one
  write (withdrawn before the body is read, restored if the write fails), and expires after 6 hours.
  The compile route records under a key only with the run's compile token from its sandbox (many
  records); compiling itself needs nothing. A key alone grants nothing (`pendingSeeds` and
  `issuedCaches` are gone). The token goes in a header, not the URL: the demo build records requests
  by URL (ADR 0015).
- **F3: each route reads at most its limit, while the body streams** (`readBody`,
  `src/orchestrator/host-server.ts`). `HostRequest.body(max)` refuses a body as soon as its
  Content-Length or the bytes received exceed `max` (default `BODY_MAX`, 1 MB): compile and tla-scan
  32 MB (`SOURCE_BODY_MAX`; next dev's largest chunks are ~8 MB), a dev-server cache 256 MB
  (`DEV_CACHE_MAX`). The host server answers 413; the rest of the body is dropped as it arrives, and
  the connection closes 1 s later unless the body ended (closing at once, with the client's bytes
  unread, reset the connection and lost the 413). The dev-cache route checks the token before it
  reads the body, and a refused body does not spend it. **A run's network records are bounded**
  (`record`, `src/orchestrator/egress.ts`): the first 200 blocked and 200 failed requests, URLs and
  reasons cut at 2 KB; `network.requests` counts all.
- **F5: a lockfile location must be strictly inside the install's node_modules**
  (`isInstallLocation`, `src/adapters/node/package-store.ts`): `node_modules/<package>`, nested as
  `…/node_modules/<package>`, a package being a name or `@scope/name` whose segments are not empty, `.`
  or `..`, with no slash, backslash, NUL or drive colon. A lockfile with any other location goes to
  npm, as lockfiles the store does not handle did. Unpacking into the store also skips a tarball entry
  that, joined, would not be inside its new directory (the tar reader drops `..` and absolute names;
  this covers a platform separator inside a name).
- **F4: the page gets "internal error (logged by the host)"**; the error and the request's path go to
  `HostServer`'s `onError` (stderr by default).

## Tests

Each fails on main and passes with its fix.

- F1: `test/unit/egress-proxy.test.ts`: the parser's rules; `[`, `[::1`, `host:`, `host:0443`,
  `host:99999`, an empty and a 5 KB target each get a 400 and are recorded, an IPv6 literal gets a
  403, and the proxy still tunnels to an allowlisted origin after them (main: an uncaught `Invalid
  URL`); the matcher on non-URLs. `test/unit/host-server.test.ts`: a WebSocket upgrade and a GET to
  `//[` get a 404 and a 400 and the server keeps serving. `test/e2e/run.test.ts`: an app opens popups
  to `https://[::1]/`, `https://[::1]:8443/x` and an IPv4-mapped literal; they are recorded as blocked
  and the session then runs another app (main: the host process's uncaught exception).
- F2: `test/unit/dev-cache-writes.test.ts`: beside the seed run, an app's posts under the seed's key
  without a token, with its own, with a guessed one, and with the seed's token from its own sandbox
  are refused, and the seed run's write then lands; a replayed token, a token before its sandbox is
  known, a failed write that keeps the token; compiles recorded only with the run's token from its
  sandbox. `test/e2e/node.test.ts`: the first Pages Router app of a set of versions posts a planted
  cache under its seed's key (computed from its versions) until its seed run's install has issued it
  (main: 200 on the first post; now every post is refused, and the seed run's own cache is stored).
  `test/e2e/run.test.ts`: a new project's run still stores its dev-server cache and its compiles.
- F3: `test/unit/host-bodies.test.ts`, against the host server with the node adapter: for compile,
  tla-scan and dev-cache, a body declared over the limit and a chunked one of up to 1 GB get a 413
  while the client has sent at most the limit plus what sockets buffer; a dev-cache write without a
  token gets its 403 while 64 KB of a declared 200 MB were sent; an authorised write within the limit
  lands; a route without a limit reads up to `BODY_MAX`. `test/unit/egress-proxy.test.ts`: 250
  blocked tunnels leave 200 entries; 1 MB URLs are kept as 2 KB.
- F5: `test/unit/package-store.test.ts`: `node_modules/../../<dir>` and ten other malformed locations
  are refused and nothing is written beside the project (main linked the package there); the
  location rules.
- F4: `test/unit/host-server.test.ts`: an adapter's error naming a host path: a 500 without the path,
  the message or a stack, and `onError` got it.

## Consequences

- BENCH
- **Behavior changes**: a CONNECT target that is not `host:port` (a zero-padded or missing port, a
  bracket without an IPv6 literal) gets a 400 instead of a tunnel attempt or a 403. A page's POST to
  `/__sandburg/dev-cache/<key>` without its run's token is refused whatever the key, and a run
  stores its cache once. Compiles are recorded only from a run's own page; an adapter's
  `HostRequest.body()` reads at most 1 MB unless the route asks for more. A run's
  `network.blocked` and `network.failed` hold at most 200 entries each. A host error's details are
  on the host's stderr, not in the page.
- `HostRequest` gains `sandbox` and `headers`, `body(max)` takes a limit, and `HostInstallOptions`
  gains `sandbox`: additive.
- No run's speed changes: a token is a 32-byte random value per run; the body limits are counters
  on the stream.

## Not fixed

- **Reads by key.** `/__sandburg/dev-cache/<key>/bundle` and `/__sandburg/compile-cache/<key>`
  answer any sandbox that names a key some run was handed. A project's key is a digest of all its
  files and its install, so a page that can name it knows the project already; a seed's key is
  public, and its content is Sandburg's seed project's. Binding reads to the run would cost a lookup
  per bundle for no gain we found.
- **Preload lists.** A page that requests another install's files (`/__sandburg/nm/<install key>/…`)
  adds them to that install's preload list; the bundle then holds more of that install's own files.
  Integrity holds (the files are the install's); the cost is a larger bundle.
- **Compile CPU.** A page can keep the host's esbuild busy with 32 MB compiles; the host's compiles
  are bounded in memory by size (ADR 0039), not in rate.
