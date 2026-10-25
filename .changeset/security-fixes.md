---
"sandburg": patch
---

Security fixes ([ADR 0040](docs/adr/NNNN-security-fixes.md)). The egress proxy parses CONNECT targets strictly (`host:port`, a bracketed IPv6 literal, a port 1-65535 without leading zeros) and refuses others with a 400, and no connection's fault can end the host process. A dev-server cache (a Next.js or Vite seed included) and the compile cache are written only with a random token issued to the run, from that run's own sandbox, once for a cache: a key alone grants nothing. Request bodies to the host are limited per route while they stream (413: compile and tla-scan 32 MB, a dev-server cache 256 MB, others 1 MB), and a run records at most 200 blocked and 200 failed requests. The package store refuses lockfile locations outside the install's node_modules. A host error's details are logged on the host, not sent to the page.
