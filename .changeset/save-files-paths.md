---
"sandburg": patch
---

Validate saved file paths on the host. `run --save-files` (and `collectFiles`/`onAppFiles` in the API) keeps only the files whose path matches the pattern and is relative, normalized and portable (no `:`, trailing dots or spaces, or 8.3 short names), outside `node_modules`, dot directories and `.git`. Over 1000 files or 256 MB in all, none are kept, and `onAppFiles`' new `refused` argument (a warning from the CLI) says why. An invalid `collectFiles` pattern fails `run()` up front. `--save-files` writes each file to a new file renamed into place, keeping the mode of the file it replaces, and skips, with a warning naming each path and why, a file whose path goes through a symlink, is not a regular file, or fails to be written.
