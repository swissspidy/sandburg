---
"sandburg": patch
---

A program the app runs as text (`node -e`, `node -p`, `node -v`, `node -` reading its stdin, or a worker thread with `eval: true`) no longer leaves an `[eval-<pid>].js` file in its working directory: its text is kept in the project's `.sandburg/` (which the file tree hides) while it runs and removed once it exits, is killed or fails. A watcher of the whole project still sees that file come and go in `.sandburg/`. As in Node, it runs as `[eval]` (`[stdin]`, `[worker eval]`) of its working directory: `require('./x')` in a worker's eval code now resolves from the working directory instead of failing, and `process.argv` no longer holds a temporary file's path.
