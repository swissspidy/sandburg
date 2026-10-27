---
"sandburg": patch
---

A port served by a child process or worker thread is forgotten once its server closes or the child ends: a request in flight to it fails at once (`socket hang up`, a 502 for the page) instead of hanging, and later requests and connections are refused (ECONNREFUSED) as on a real machine, as when a dev script's server crashes under concurrently. A response cut short by the crash aborts the client's stream as Node does ('aborted', then an ECONNRESET "aborted" error and 'close'), so `for await` and `pipeline` reject; a server closed in the tick it listens is never announced; and a request that reaches a server just after it closed is refused with ECONNREFUSED.
