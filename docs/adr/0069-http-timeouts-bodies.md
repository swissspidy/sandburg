# ADR 0069: http shim: server timeouts, streamed request bodies, and when a connection's events come

- Status: Accepted
- Date: 2026-10-28

## Context

PR #108 (`http-shim-gaps`) gave the runtime's `node:http` `req.abort()`, server-side cancel,
`req.setTimeout` and an agent's `maxSockets`. Three gaps were left:

- **Server timeouts did nothing.** `server.setTimeout`, `server.timeout`, `res.setTimeout` and a
  server's `req.setTimeout` were no-ops, so no 'timeout' event came and no idle connection closed.
  `requestTimeout`, `headersTimeout` and `keepAliveTimeout` were plain properties.
- **Request bodies went whole.** A loopback request (to a server in the same runtime, or in another
  through `loopback.route`) was sent when it ended, with its whole body. A server could not read a
  body as it came, never saw a POST that was destroyed mid-body, and saw its `'data'` at other times
  than in Node.
- **Events after a destroy came too early.** The runtime emitted a destroyed request's `'error'`
  and `'close'` in a microtask, before a `process.nextTick` queued after `destroy()`, and
  `abort()` after `destroy()` emitted `'abort'` synchronously.

Every behaviour below was measured in Node 24.22 (Linux) with programs that now live in
`test/runtime/fixtures/http/`. Each runs unchanged under `node`, and the tests expect what Node
printed for it.

## Decision

### When a connection's events come: libuv's phases, in the runtime's own loop

What Node does after a destroy depends on libuv's phases:

- A socket's `'close'` comes from its handle's close callback, which runs in the loop's close
  phase. That is after the `process.nextTick` callbacks, promises and `setImmediate` callbacks the
  turn queued, and before the next timers.
- libuv runs close callbacks last-closed first: its closing handles are a stack. Three requests
  destroyed in one tick emit `'close'` as `req3,req2,req1`.
- What one end of a connection does reaches the other end in the next poll phase. From a timer's
  callback that is the same iteration's poll, before this turn's immediates and close callbacks.
  From I/O, an immediate or a close callback it is the next iteration's poll, after them. So
  `res.destroy()` in a request handler closes the server's side first, while `res.destroy()` from a
  `setTimeout` lets the client hear first.

The runtime's immediates (`builtins/process.ts`) are now a turn of three steps: I/O callbacks,
immediates and close callbacks. Each callback is a task of its own, so what it queued with
`process.nextTick` or promises runs before the next callback, as in Node. Close callbacks run
last-in first-out. `onClosePhase(fn)` queues a close callback. `onPeerPhase(fn)` delivers to the
other end of a connection by the phase the caller runs in: a timer's callback (and its microtasks)
counts as the timers phase, the steps count as theirs, and anything else (messages, fetches) counts
as poll.

On top of that:

- **A request's socket.** `ClientRequest.destroy()` with a socket closes the connection.
  `destroy(err)` emits `err` on the next tick, and everything else comes as the socket closes
  (`onClosePhase`), as Node's `socketCloseListener` emits it. Before a response that is "socket
  hang up" unless `err` came first. With a response in flight, the response's `'aborted'`, then the
  request's `'close'`, then the response's `'error'` and `'close'`. Destroyed before it has its
  socket, it fails once it gets one (Node's `onSocketNT`): `'error'` (none if aborted), then
  `'close'`. `abort()` always emits `'abort'` on the next tick. A response the program destroys
  closes its request as its socket closes. `'finish'` comes once the request went out, not at
  `end()`.
- **A server's socket** (`FakeSocket`) closes in the close phase. A destroyed request whose
  connection is still open, or one with an error, settles a tick later (Node's
  `IncomingMessage._destroy`). A finished response's `'close'` comes a tick after the request's.
- **A connection in one runtime** has two wires (`wire()` in `http.ts`), one per direction. What an
  end does (the request, each body chunk, the response, a reset) reaches the other end through
  `onPeerPhase`, in order. The server's reset is sent as its socket is destroyed, not once it closed.

### Streamed request bodies

A loopback request goes out once it has its socket and was written to, flushed (`flushHeaders()`)
or ended. Its body follows chunk by chunk (`Server.dispatch(…, STREAMED)` and `Dispatched.write` and
`end`). Between runtimes it travels as `lb-body`/`lb-body-end` (up) and
`request-body`/`request-body-end` (down), and is forwarded the same way by a runtime between the
two. The page's own requests keep their whole body (`request` with an ArrayBuffer), as before.

Framing is Node's, decided as the headers are:

- Written to before its end: `Transfer-Encoding: chunked`, each chunk its own `'data'`.
- Ended first: `Content-Length` (`0` for a POST ended empty).
- A method that is not framed by default (GET, HEAD, DELETE, OPTIONS, …) and has no length: no body
  at all (Node sends it unframed and its server reads none).
- With a length the program set: what is written in a tick goes as one `'data'`.

Loopback requests also send `Connection: keep-alive` (or `close` for an agent that does not keep
connections).

**Backpressure.** A server acknowledges body bytes as its request takes them (`push()` under its
high-water mark, else on its next `_read`). Across runtimes the acknowledgement is `response-read`
or `lb-read`. A client with more than 64 KiB unacknowledged (`BODY_WINDOW`) holds its next write's
callback, so `write()` returns false and `'drain'` waits for the server, as a socket's does once the
connection's buffers are full. 8 MiB written as fast as `'drain'` allows, to a server that reads
nothing for 500 ms, stalls and then arrives intact, in one runtime and to a child.

### Server timeouts

- **Idle timeout.** `server.timeout` / `server.setTimeout(ms, cb)` set a connection's idle timeout
  when the connection comes, so setting it later does not change existing connections.
  `res.setTimeout(ms, cb)` and a server's `req.setTimeout(ms, cb)` set their connection's timeout
  and add `cb` as a 'timeout' listener. What is read (a body chunk) or written (a response's
  output) starts the idle time over. The timer does not keep the process alive.
- **When it fires** (Node's `socketOnTimeout`): 'timeout' with the socket, on the request while its
  body is still coming, on the response until it finished, and on the server. When none of them
  listens, the connection is destroyed. Its client sees "socket hang up", or its response cut short.
- **requestTimeout.** A request whose body is still coming is checked every
  `connectionsCheckingInterval` (30 s by default; a timer that does not keep the process alive,
  from 'listening' until `close()`). Without a 'clientError' listener it gets a 408 and its
  connection closes; with one, the listener gets `ERR_HTTP_REQUEST_TIMEOUT`. Measured in Node 24, a
  request expires after the longer of `requestTimeout` and `headersTimeout` (300 ms and 60 s: not in
  1.5 s; 300 ms and 600 ms: at about 650 ms), and that is what the runtime does.
- **headersTimeout** times nothing else: a request's headers always come whole here.
- **Options** are validated as Node's (`validateInteger`): `headersTimeout` defaults to the smaller
  of 60 s and `requestTimeout`, and must not exceed it.
- **What a 'clientError' listener writes to the socket itself** (`socket.end('HTTP/1.1 400 …')`) now
  reaches the client as a response, as does Node's own 408.
- **keepAliveTimeout, where it is observable.** A connection does not close when its response
  finishes:
  - A request that asked for `Connection: close` closes it at once. Node's agents ask for that
    unless they keep connections alive (`new Agent()`, `agent: false`).
  - A Node agent that keeps connections closes them after its own timeout (the global agent's is
    5 s), shortened to a second less than the server's `Keep-Alive` hint (whole seconds of
    `keepAliveTimeout`), or at once when that leaves none (`Agent.keepSocketAlive`).
  - Otherwise, the page's requests among them, the server's `keepAliveTimeout + keepAliveTimeoutBuffer`
    times it, and then it is the server's 'timeout' or the connection closes.

  This is visible as the server's `req.socket` 'close' and 'timeout'. Connections are still not
  reused for a second request.

## What is still different

- **process.nextTick against promises.** The runtime's `process.nextTick` is a microtask, so a
  nextTick queued after a promise runs after it, where Node runs every nextTick first. One measured
  case shows it: a client response the program destroys emits its 'close' after a promise queued
  before it, where Node emits it before. The test leaves promises out of that case.
- **A 408 without a length ends a step early.** Node ends the empty, length-less 408 response it
  writes for `requestTimeout` only once the server's side of the connection has closed. The runtime
  ends it as it arrives. The test asserts the 408 and the server's events, not where `'end'` falls
  among them.
- **Timers against the loop's steps.** The runtime's turn is a chain of tasks, so a `setTimeout(…,
  0)` (1 ms in a browser) can fire between them, before a close callback Node would run first.
- **Between runtimes**, the order of one process's events against another's is not Node's to
  promise either; it is not modelled beyond the order of each connection's own messages.

## Tests

`test/runtime/http-order.test.ts` and `test/runtime/http-bodies.test.ts`, each against the Node 24
output of its `fixtures/http` program:

- 35 destroy/abort/end orderings (`destroy-order.cjs`), with the server in the same runtime and in
  a child process.
- A server's own destroys (`server-destroy.cjs`), and which end hears first (`which-side.cjs`).
- The loop's steps: ticks between immediates and between close callbacks, close callbacks
  last-closed first, and immediates queued in them (`loop-phases.cjs`).
- Streamed bodies by echo, a client gone mid-body, and timeouts across runtimes, in four
  topologies: one runtime, a child's server, a child's client, and siblings through their parent
  (`streamed-body.cjs`).
- Framing and `'data'` timing (`body-framing.cjs`), and backpressure in one runtime and to a child
  (`backpressure*.cjs`).
- Server timeouts and requestTimeout (`server-timeouts.cjs`), keep-alive by agent
  (`keep-alive.cjs`), and options (`server-options.cjs`).

Each fix was mutation-checked against these tests.
