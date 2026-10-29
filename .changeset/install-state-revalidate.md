---
"sandburg": patch
---

A process that keeps running while `.sandburg` is removed (a test runner, a server) no longer trusts installs that are gone. A later `Session` failed with `the dev script runs "vite", which no installed package provides`, because the host remembered each finished install for the life of the process. An install that is asked for again is now checked with one `stat` of its completion record: when the record is gone or is a new one (the install was removed, or removed and made again), the install is made again, and what the host kept of it is dropped (its file index, transforms in memory, package types, read-ahead listings, preload lists and bundles). Side installs are checked the same way. Compiles kept in memory whose file was removed are read again from disk, and a seed run whose stored cache was removed runs again (#117).
