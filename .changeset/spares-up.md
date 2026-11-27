---
'sandburg': patch
---

A short-lived CLI that starts napi-rs WebAssembly threads from a synchronous call, in a dev script's child process, no longer hangs: the Tailwind CLI (`tailwindcss -i … -o …`, whose `@tailwindcss/oxide` scans with threads) writes its CSS and exits, and the next command runs. A process starts its program once the spare runtimes its threads take are up, as the main program does; until then, a new thread's first message to its spare waited for the blocked program to run a task.
