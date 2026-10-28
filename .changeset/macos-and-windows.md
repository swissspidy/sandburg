---
"sandburg": patch
---

Sandburg runs on macOS and Windows hosts, which CI now tests. On Windows, npm is started as its own `npm-cli.js` on the running Node (`npm.cmd` cannot be spawned without a shell, so every install failed), and a preload list's rename waits out another process that has the file open instead of dropping its entries. The resolver gives npm the install directory's real path, so a directory reached through a symlink (macOS's temporary directory) gets the same lockfile as any other. On macOS, the memory a batch checks before it opens another app counts inactive pages too, not only the free ones `os.freemem()` reports. `npm run build` no longer needs `rm`.
