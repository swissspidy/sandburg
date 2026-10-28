---
"sandburg": patch
---

A response its handler destroys (`res.destroy()`, or its socket destroyed or closed) now resets the connection as in Node: the client's request fails with ECONNRESET ("socket hang up") instead of waiting forever, whether it came from the page, a parent process or a child process. A child process that exits or dies mid-request aborts its request in its parent's server (`req` emits 'aborted' and 'close'), and the parent no longer keeps such requests until it exits. `sandburg compare` cut short by SIGINT or SIGTERM is now covered by a test.
