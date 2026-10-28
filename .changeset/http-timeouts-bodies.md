---
"sandburg": patch
---

More of `node:http` behaves as in Node 24:
- Server timeouts work. `server.setTimeout()`, `server.timeout`, `res.setTimeout()` and a server's `req.setTimeout()` emit 'timeout' on the request, response and server. When nobody listens, the connection closes.
- `requestTimeout` fails a request whose body takes too long with a 408, or with 'clientError'.
- A connection stays open after its response for as long as its client's agent or the server's `keepAliveTimeout` keeps it.
- A request body to a server on this machine streams chunk by chunk, framed as Node frames it, including between processes. A client that writes faster than its server reads waits for it.
- A server sees a POST that was destroyed mid-body as 'aborted'.
- What destroying or aborting a request emits comes when it does in Node: as its socket closes, after the callbacks the turn queued. 'abort' comes on the next tick.
- Callbacks queued with `process.nextTick` or promises run between two immediates, and a timer that comes due while immediates run waits for them, as in Node.
- A server tracks its connections ('connection', `getConnections()`); `close()` closes the idle ones, and `closeIdleConnections()` and `closeAllConnections()` work. `unref()` lets the process exit.
- `Expect: 100-continue` and informational responses (`writeContinue()`, `writeEarlyHints()`) work, with 'checkContinue', 'checkExpectation', and the client's 'continue' and 'information'.
