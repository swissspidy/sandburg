---
"sandburg": patch
---

Validate saved file paths on the host. `run --save-files` (and `collectFiles`/`onAppFiles` in the API) keeps only the files whose path matches the pattern and is relative and normalized, outside `node_modules`, dot directories and `.git`, at most 1000 files and 256 MB in all. `--save-files` writes each file to a new file renamed into place, and skips (with a warning) a file whose path goes through a symlink or is not a regular file.
