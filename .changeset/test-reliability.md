---
"sandburg": patch
---

A run's report of the preload bundle's files it read is no longer lost when the runtime's file channel opens after it: on a busy machine, the channel can take longer to open than the report's 500 ms, and the install's next preload bundle then left out the files its runs read first. The test suites no longer fail on a loaded machine (fixed waits and timers replaced by waiting for what they wait for), unit tests leave nothing in the temp directory, and `scripts/flakes.ts` runs test files again and again under load to find flaky ones (docs/testing.md).
