---
"sandburg": patch
---

Tests for the security model's boundaries, tried from outside: the host server's Host and `Sec-Fetch-Site` checks and the file channel's upgrade, `/__sandburg/nm` paths (`..`, links, keys), dev caches under keys the host did not issue or outside their directories, plain HTTP and CONNECT through the egress proxy, and the package store's linked files. CI runs the page-checks suite, reports each suite's and its slowest tests' times in the job summary with a budget per suite, and installs Chromium without apt unless it does not start. The unit suite is ~35% faster, and a batch suite whose browser does not launch fails instead of hanging. No change to what the package does.
