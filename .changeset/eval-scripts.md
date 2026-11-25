---
"sandburg": patch
---

A program the app runs as text (`node -e`, `node -p`, `node -v`, `node -` reading its stdin, or a worker thread with `eval: true`) no longer leaves an `[eval-<pid>].js` file in its working directory: its text is kept in the project's `.sandburg/` while it runs and removed once it exits, is killed or fails, so the app's directory listings, its file tree and dev-server watchers no longer see it. As in Node, it runs as `[eval]` (`[stdin]`, `[worker eval]`) of its working directory: `require('./x')` in a worker's eval code now resolves from the working directory instead of failing, and `process.argv` no longer holds a temporary file's path.
