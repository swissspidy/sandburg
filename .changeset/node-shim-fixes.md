---
"sandburg": patch
---

Node compatibility fixes in the runtime: `fs.openSync` decodes numeric and `r+` flags as open(2) does (no truncation without `O_TRUNC`, `O_EXCL` honoured), `writeFile` takes `wx`/`a`/`r+` flags, `fs.read`/`readSync` take an options object, `fs.write`'s callback gets the buffer, file streams emit `open` and `ready`, and `unwatchFile` stops only the listener named. A throwing `setImmediate` callback no longer drops the rest of its batch, `Timeout.refresh()` after a timeout fired keeps the process alive, and `process.exit()` in an `exit` listener ends the process with its code. `net` sockets end their side when the peer does (`allowHalfOpen: false`, as in Node), so programs that use them exit; a killed `shell: true` child reports its signal. On the host, stored compiles are keyed by the esbuild version, a cache bundle made while its cache was rewritten is not kept, and requests waiting when the app exits or crashes are answered with an error.
