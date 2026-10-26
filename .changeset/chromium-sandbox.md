---
"sandburg": minor
---

Chromium now runs inside its OS sandbox by default, with every site in a renderer process of its own (`--site-per-process`). Before, Playwright's default launched it with `--no-sandbox`. Where the sandbox cannot start (as root, or where user namespaces are restricted, as AppArmor does on Ubuntu 23.10 and later), `Session.open()` fails with what to change. Sandburg does not fall back to an unsandboxed browser by itself; `--no-browser-sandbox`, `SANDBURG_NO_BROWSER_SANDBOX=1` or `browserSandbox: false` turns the sandbox off explicitly. Each run's `result.json` records the choice (`environment.browserSandbox`), as does a batch's `summary.json` (`browserSandbox`), and the CLI warns when the sandbox is off. Playwright's `--enable-unsafe-swiftshader` switch is left out: the headless shell runs WebGL without it.
