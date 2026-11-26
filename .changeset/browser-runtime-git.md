---
'sandburg': minor
---

`sandburg/browser-runtime` runs projects with git dependencies (`github:user/repo#v1`): `startProject` takes a fetcher, `EmbedOptions.git`, that resolves each one to a commit and returns its files, through a server of the embedder's (the git hosts send no CORS headers, so the page cannot fetch them itself). The files go where a Sandburg host puts them (`.sandburg/git/`, `.sandburg/git.json`), and the install links them as a host's. `withGitDependencies`, `GIT_DIR` and `GIT_FILE` are exported for pages that drive the host themselves. Without a fetcher, the install's error says how to give one.
