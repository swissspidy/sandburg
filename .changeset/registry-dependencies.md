---
"sandburg": patch
---

The host installs registry dependencies only: a project's dependencies, devDependencies, overrides and package-lock.json may name registry versions, ranges, dist-tags and `npm:` aliases of them, as the browser installer already requires. A git, URL, `file:`, `link:` or path dependency fails the install with an `UnsupportedDependencyError`. npm's git is disabled during installs.
