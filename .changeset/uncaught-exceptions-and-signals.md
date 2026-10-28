---
"sandburg": minor
---

The Node runtime handles uncaught exceptions and unhandled rejections as Node 24 does:

- A top-level throw reaches `'uncaughtException'` listeners and the program goes on.
- Without a listener, `'exit'` listeners run with code 1.
- `'uncaughtExceptionMonitor'` and `process.setUncaughtExceptionCaptureCallback` work.
- A throw in a listener exits with code 7.
- An unhandled rejection ends the process by default; `--unhandled-rejections` selects Node's other modes.
- `process.emitWarning` emits `'warning'`, and honours `--no-warnings`, `NODE_NO_WARNINGS` and the deprecation options.

`process.kill` and `child.kill` validate signals as Node on Linux does (SIGBREAK is unknown there). A signal a process sends itself reaches its listeners, or ends it at once.

Ctrl-C, a kill and (on Windows) Ctrl-Break stop `run`, `batch`, `open` and `compare`, close the browser and exit 130, 143 and 149. A Ctrl-C during `run` exited 1 with an uncaught error before.
