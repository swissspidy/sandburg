---
"sandburg": patch
---

Faster runs on the host's side: the egress gateway intercepts only HTTPS, so the sandbox's own requests are no longer paused for a round trip through the host (and the browser's HTTP cache stays on); only the host server's port on `*.sandburg.localhost` bypasses the egress proxy, and the host server refuses requests from other sites. ES modules are converted without an acorn pass, the prefetch of a never-run install transforms 8 files at a time, and the host's compiles are kept on disk (`.sandburg/compiled`) for the next process.
