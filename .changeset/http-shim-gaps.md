---
"sandburg": patch
---

More of `node:http` behaves as in Node:
- `req.abort()` destroys the request and emits 'abort'.
- A server learns when its client on this machine goes away (`req.destroy()`, `req.abort()`, or the response destroyed): its request emits 'aborted' and its response 'close'. This also works between a process and its child processes.
- What a response writes in the tick it is destroyed in does not reach the client, which sees only the reset.
- `req.destroy(err)` emits the request's error before the response's 'aborted'.
- `req.setTimeout()` and the `timeout` option emit 'timeout' once the request is idle that long.
- An agent's `maxSockets` limits the requests that go on at once.
- `process.exit()` in an 'uncaughtException' or 'unhandledRejection' handler ends the process with its code.
