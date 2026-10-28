---
"sandburg": minor
---

Add a GitHub Action: `uses: swissspidy/sandburg@<ref>` runs a project with `sandburg run`, installs Playwright's Chromium (cached), writes the checks to the job summary, uploads `.sandburg/runs` and sets the outputs `status` and `result-path` (docs/guide/agents-and-ci.md).
