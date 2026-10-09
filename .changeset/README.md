# Changesets

A pull request that changes what the package does adds a changeset: run `npx changeset`, pick the
bump (patch, minor or major; Sandburg is 0.x, so a breaking change is a minor) and describe the change
for the changelog. Commit the file it writes here.

The Release workflow collects the changesets on `main` into a "Version packages" pull request, which
bumps `package.json` and writes `CHANGELOG.md`. Merging that pull request publishes the new version to
npm and creates its GitHub release (docs/adr/0022-npm-package.md).
