---
"sandburg": patch
---

A check that runs out of time is stopped: the Playwright call it waits in is aborted, any it makes after that fails at once, and its `toPass` stops retrying; the app then loads again before the next check, so nothing the check left half done carries over. Checks get `signal`, an `AbortSignal` that aborts when they are stopped (also with `--checks-in page`). A checks phase that runs out of time keeps the checks that finished and the screenshot and accessibility snapshot already taken: the check running at the deadline fails, and those not started are reported as skipped. The CLI marks skipped checks `skip`, and its help says exit code 2 also means the checks did not finish in time.
