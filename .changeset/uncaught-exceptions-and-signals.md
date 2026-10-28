---
"sandburg": minor
---

The Node runtime handles uncaught exceptions and unhandled rejections as Node 24 does:

- A top-level throw reaches `'uncaughtException'` listeners and the program goes on.
- Without a listener, `'exit'` listeners run with code 1.
- `'uncaughtExceptionMonitor'` and `process.setUncaughtExceptionCaptureCallback` work.
- A throw in a listener exits with code 7.
- An unhandled rejection ends the process by default; `--unhandled-rejections` selects Node's other modes.

`process.kill` and `child.kill` validate signals as Node on Linux does (SIGBREAK is unknown there). A signal a process sends itself reaches its listeners.

On Windows, Ctrl-Break stops `run`, `batch`, `open` and `compare`, closes the browser and exits with code 149.
