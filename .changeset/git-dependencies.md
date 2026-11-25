---
"sandburg": minor
---

Git dependencies install. A dependency on a public GitHub, GitLab or Bitbucket repository, in any of npm's shapes (`user/repo`, `github:user/repo#branch`, `git+ssh://git@github.com/user/repo.git#v1.2.0`, `#semver:^1`, `::path:packages/x`), is fetched by the host and linked into node_modules as a local package, its registry dependencies installed with the app's, with either install. npm never sees it, so its `prepare` script is not run. A branch or tag is resolved with one ls-refs request (isomorphic-git), not at all for a full commit id or the commit a package-lock.json records, and a commit's files are one archive download, kept on disk: a second run fetches nothing. Other git hosts can be allowed with `SANDBURG_GIT_HOSTS`. A repository, branch or tag that is not there is an app bug (`unresolvable-dependency`). `AdapterDescriptor` gains an optional `sources` hook (ADR 0073).
