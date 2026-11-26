---
"sandburg": minor
---

`sandburg serve <project>` serves a project for your own browser, for a machine where Playwright cannot show one (a remote dev box reached over SSH, a container): the page installs its packages from the npm registry and runs its dev server in the browser. It needs no Playwright, listens on 127.0.0.1 by default (`--host`, `--port`), and is not a Sandburg run: no checks, no result, and no egress allowlist, since the app's requests are your browser's.
