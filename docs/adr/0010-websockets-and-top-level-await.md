# ADR 0010: WebSockets (and hot reloading) and top-level await in the node runtime

- Status: Accepted
- Date: 2026-09-30
- Amends ADR 0006 and ADR 0009, which listed both as unsupported.

## Context

Two gaps in the node runtime (ADR 0006) kept real apps from running:

- **WebSockets.** App requests reach virtual servers through the sandbox's
  service worker, and a service worker cannot answer a WebSocket. So:
  - Next.js' hot-reloading socket (`/_next/webpack-hmr`) got a 404,
  - socket.io and `ws` servers were unreachable, including Vite's
    `ws: true` proxies in full-stack apps (ADR 0009).
- **Top-level await.** The runtime's loader is CommonJS, and it converts ES
  modules with esbuild, which cannot convert modules that use top-level
  `await`. So ESM backends that `await` their setup (database connections,
  migrations) failed to compile.

## Decision 1: WebSockets relayed from the app frame to a real upgrade

- **In the page.** The service worker inserts `/__sandburg/ws-shim.js` at the
  start of `<head>` in every HTML page it serves to the app frame. It streams
  through and holds back only the bytes before `<head …>`. The shim replaces
  `window.WebSocket` before any app script runs, but only for connections
  the sandbox serves itself:
  - same-origin URLs,
  - `ws(s)://` or `http(s)://localhost:<port>` (and `127.0.0.1`) where a
    virtual server listens.

  Other URLs get the browser's WebSocket and the usual egress rules. The shim
  implements the WebSocket API (`readyState`, `protocol`, `binaryType`,
  `send` of strings, Blobs and buffers, `close`, events and `on*` handlers).
  It hands the connection to the host page (`window.top.__sandburgWs`) over
  a `MessagePort`.
- **Routing.** The host page decides the port:
  - the node adapter sends same-origin sockets to the app's server;
  - the esbuild adapter sends paths that match Vite's `server.proxy` (for
    example `'/socket.io': { target, ws: true }`) to the backend.
  - `localhost:<port>` goes to that port, in both.
- **In the runtime.** `http.Server.upgrade()` emits `'upgrade'` with a real
  Duplex socket (`UpgradeSocket`), as Node does for an HTTP upgrade request.
  The request carries `Upgrade`, `Sec-WebSocket-Key`/`Version`/`Protocol`,
  `Origin` and cookies. So `ws`, socket.io and Next.js' HMR server run their
  own handshake and framing. The runtime acts as the client
  (`src/node-runtime/websocket.ts`):
  - it reads the `101` response (the chosen subprotocol) or a rejection,
  - it decodes frames (fragments, ping → pong, close handshake),
  - it masks the page's messages into client frames.

  With no `'upgrade'` listener, the connection is refused, as in Node.
- **Fidelity fix.** `req.socket.server` now refers to the server, as in Node.
  Next.js finds its HTTP server that way to attach its upgrade handler.

**Hot reloading.** `NodeProcess.writeFile()` (and `window.__sandburgWriteFile`
on the host page) writes a project file in the running runtime, as an editor
would. Watchers see the change: webpack rebuilds, and Next.js pushes the
update over its HMR socket. `test/e2e/websockets.test.ts` edits
`app/page.tsx` in the running Next.js fixture. The heading updates, and a
marker on the app's `window` survives, which proves an in-place hot update
rather than a reload.

## Decision 2: Top-level await via async modules

As bundlers do for top-level await, such a module becomes an async module
(`src/adapters/node/tla.ts`, using acorn on the host):
- imports, re-exports and function declarations stay static,
- other top-level declarations become module-scope bindings, assigned in an
  async function that holds the rest of the body,
- exports stay live bindings,
- the function's promise is exported as `__sandburg_tla`.

A module first awaits the `__sandburg_tla` of everything it imports, so
modules evaluate in import order, each after its dependencies have finished.

**When modules become async.** When the runtime starts, the host parses the
project's sources once (`/__sandburg/tla-scan`). If any uses top-level
`await`, every project ES module is compiled this way, so importers of an
async module wait. A module with top-level `await` is always compiled this
way, including in node_modules.

**Failures.** The entry module's promise rejecting is fatal, like an
uncaught exception in Node. So a backend whose `await db.connect()` throws
is an app bug with its error.

## Consequences

- Tested end to end:
  - Next.js hot reloading, with no WebSocket errors,
  - socket.io (long-polling, then upgrading to a WebSocket) through Vite's
    `ws: true` proxy and through a direct `http://localhost:3001` URL
    (fixture `vite-socketio-chat`),
  - an Express backend with top-level `await` before `listen()`.
- Runtime tests cover the WebSocket protocol against a hand-written server:
  - subprotocol negotiation, ping and pong, fragmented messages,
  - binary echo, the close handshake, rejected paths.

  They also cover async-module evaluation order and fatal rejections.
- Next.js warns that dev resources are requested from the sandbox's host
  name (`allowedDevOrigins`). This is harmless today, but a future Next.js
  may require configuring it.
- Not covered:
  - `permessage-deflate` (the client offers no extensions, so servers send
    uncompressed frames),
  - a proxy `rewrite` applied to WebSocket paths,
  - `require()` of an async module from CommonJS (Node throws
    `ERR_REQUIRE_ASYNC_MODULE`; here the exports are read before the body
    has finished),
  - `import()` of an async module (it resolves before the module's body has
    finished).
