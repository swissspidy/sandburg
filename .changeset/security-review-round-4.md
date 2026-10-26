---
'sandburg': patch
---

Bound the file-channel WebSockets one sandbox may hold open (256; further upgrades get a 503), so one run cannot exhaust the host's file descriptors. Adds mutation fuzzers for the file-channel WebSocket frame reader and the egress proxy's CONNECT parser, and records the round-4 security review (ADR 0054). The registry-only install rule it reviews shipped with #67.
