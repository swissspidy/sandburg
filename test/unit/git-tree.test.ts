/** Git dependencies from a page's fetcher (git-tree.ts): what sandburg/browser-runtime's EmbedOptions.git fills in (#179). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_FILE, withGitDependencies, type GitDependencyRequest, type GitFetcher } from '../../src/adapters/node/git-tree.ts';
import { pageInstall } from '../../src/adapters/node/plan.ts';
import { installPlan } from '../../src/adapters/node/local-packages.ts';
import type { FileTree, PackageJson } from '../../src/types.ts';

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const project = (dependencies: Record<string, string>) => {
  const packageJson: PackageJson = { name: 'app', dependencies, scripts: { start: 'node index.js' } };
  return { files: { 'package.json': JSON.stringify(packageJson), 'index.js': "require('hermite-resize');" } as FileTree, packageJson };
};

test("a page's fetcher fills in a git dependency where the install plan links it, and one it names in turn", async () => {
  const { files, packageJson } = project({ 'hermite-resize': 'github:viliusle/Hermite-resize#master' });
  const asked: GitDependencyRequest[] = [];
  const fetchGit: GitFetcher = async (dependency): Promise<{ commit: string; files: FileTree }> => {
    asked.push(dependency);
    if (dependency.path === 'viliusle/Hermite-resize') {
      return { commit: COMMIT, files: { 'package.json': JSON.stringify({ name: 'hermite-resize', main: 'dist/hermite.js', dependencies: { helper: 'gitlab:acme/helper' } }), 'dist/hermite.js': 'module.exports = 1;', '.git/HEAD': 'x', 'node_modules/x/index.js': 'x' } };
    }
    return { commit: OTHER, files: { 'package.json': JSON.stringify({ name: 'helper' }), 'index.js': 'module.exports = 2;' } };
  };
  const out = await withGitDependencies(files, packageJson, fetchGit);
  assert.deepEqual(
    asked.map(({ name, host, url, committish }) => ({ name, host, url, committish })),
    [
      { name: 'hermite-resize', host: 'github', url: 'https://github.com/viliusle/Hermite-resize.git', committish: 'master' },
      { name: 'helper', host: 'gitlab', url: 'https://gitlab.com/acme/helper.git', committish: null },
    ],
  );
  const dir = '.sandburg/git/github.com-viliusle-Hermite-resize-aaaaaaaaaaaa';
  assert.equal(out[`${dir}/dist/hermite.js`], 'module.exports = 1;');
  // Git metadata and installed packages are not the package's.
  assert.equal(out[`${dir}/.git/HEAD`], undefined);
  assert.equal(out[`${dir}/node_modules/x/index.js`], undefined);
  assert.deepEqual(JSON.parse(out[GIT_FILE] as string), { 'github:viliusle/Hermite-resize#master': dir, 'gitlab:acme/helper': '.sandburg/git/gitlab.com-acme-helper-bbbbbbbbbbbb' });
  // Nothing is left for the page to fetch: the plan links both, and the page's install no longer refuses it.
  const plan = installPlan(out, packageJson);
  assert.deepEqual(plan.git, []);
  assert.equal(plan.links['node_modules/hermite-resize'], dir);
  assert.doesNotThrow(() => pageInstall({ name: 'app', path: 'app', files: out, packageJson, framework: 'unknown', snapshotId: '' }));
});

test('without a fetcher the page refuses a git dependency, and says how to give it one', () => {
  const { files, packageJson } = project({ 'hermite-resize': 'github:viliusle/Hermite-resize' });
  assert.throws(() => pageInstall({ name: 'app', path: 'app', files, packageJson, framework: 'unknown', snapshotId: '' }), /EmbedOptions\.git/);
});

test("a fetcher's answer is checked: a full commit id, a package.json at the package's directory, paths inside the repository; path: takes its directory", async () => {
  const { files, packageJson } = project({ dep: 'github:acme/mono#main::path:packages/dep' });
  const answer = (fetched: Awaited<ReturnType<GitFetcher>>): GitFetcher => async () => fetched;
  await assert.rejects(withGitDependencies(files, packageJson, answer({ commit: 'main', files: {} })), /no full commit id/);
  await assert.rejects(withGitDependencies(files, packageJson, answer({ commit: COMMIT, files: { '../escape.js': 'x', 'packages/dep/package.json': '{}' } })), /outside the repository/);
  await assert.rejects(withGitDependencies(files, packageJson, answer({ commit: COMMIT, files: { 'package.json': '{}' } })), /no package\.json at packages\/dep/);
  const out = await withGitDependencies(files, packageJson, answer({ commit: COMMIT, files: { 'package.json': '{"name":"mono"}', 'packages/dep/package.json': '{"name":"dep"}', 'packages/dep/index.js': '1' } }));
  const dir = '.sandburg/git/github.com-acme-mono-aaaaaaaaaaaa/packages/dep';
  assert.equal(out[`${dir}/index.js`], '1');
  assert.equal(out[`${dir}/package.json`], '{"name":"dep"}');
  assert.equal(Object.keys(out).filter((p) => p.startsWith('.sandburg/git/') && !p.startsWith(dir)).length, 0);
});

test('a project without git dependencies is left as it is, and the fetcher is not called', async () => {
  const { files, packageJson } = project({ lodash: '^4.17.21' });
  const out = await withGitDependencies(files, packageJson, async () => assert.fail('called'));
  assert.equal(out, files);
});

test('git dependencies the project already has (its git.json and their directories) are kept, not fetched again', async () => {
  const { files, packageJson } = project({ 'hermite-resize': 'github:viliusle/Hermite-resize#master', helper: 'gitlab:acme/helper' });
  const dir = '.sandburg/git/github.com-viliusle-Hermite-resize-aaaaaaaaaaaa';
  const had: FileTree = { ...files, [`${dir}/package.json`]: JSON.stringify({ name: 'hermite-resize' }), [GIT_FILE]: JSON.stringify({ 'github:viliusle/Hermite-resize#master': dir }) };
  const asked: string[] = [];
  const out = await withGitDependencies(had, packageJson, async (dependency) => {
    asked.push(dependency.name);
    return { commit: OTHER, files: { 'package.json': JSON.stringify({ name: 'helper' }) } };
  });
  assert.deepEqual(asked, ['helper']);
  assert.deepEqual(JSON.parse(out[GIT_FILE] as string), { 'github:viliusle/Hermite-resize#master': dir, 'gitlab:acme/helper': '.sandburg/git/gitlab.com-acme-helper-bbbbbbbbbbbb' });
  assert.deepEqual(installPlan(out, packageJson).git, []);
});
