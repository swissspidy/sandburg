---
"sandburg": minor
---

The node runtime runs synchronous child processes: `execSync`, `spawnSync` and `execFileSync` run Node programs and the runtime's shell commands while the caller waits, with Node's results and errors (`status`, `signal`, `stdout`, `stderr`, `input`, `encoding`, `stdio`, `timeout`, `maxBuffer`). Other programs (`git`) exit with 127, as with the asynchronous API. A synchronous command the runtime cannot start yet fails at once with an `ENOSYS` error that names the call.
