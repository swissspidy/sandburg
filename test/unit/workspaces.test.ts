/**
 * A monorepo's workspaces (src/workspaces.ts) and the YAML pnpm writes (src/yaml-lite.ts), and how
 * a directory inside a monorepo loads (src/project.ts, ADR 0063).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isWorkspace, workspaceDirs, workspacePatterns } from '../../src/workspaces.ts';
import { parseYaml } from '../../src/yaml-lite.ts';
import { loadProject } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

test('YAML: block mappings and sequences, quoted keys and scalars, flow collections, comments', () => {
  const doc = parseYaml(`# a comment
lockfileVersion: '9.0'
packages:
  - 'apps/*'
  - "packages/**"   # trailing comment
  - '!**/test/**'
list-at-key-indent:
- a
- b
importers:

  .:
    dependencies:
      '@acme/ui':
        specifier: workspace:*
        version: link:packages/ui
      ms:
        specifier: ^2.0.0
        version: 2.0.0(peer@1.0.0)
nested:
  flow: {integrity: sha512-abc==, tarball: 'https://x/y.tgz'}
  seq: [a, 'b c', "d"]
  empty: {}
  hash: 'not # a comment'
`);
  assert.deepEqual(doc, {
    lockfileVersion: '9.0',
    packages: ['apps/*', 'packages/**', '!**/test/**'],
    'list-at-key-indent': ['a', 'b'],
    importers: { '.': { dependencies: { '@acme/ui': { specifier: 'workspace:*', version: 'link:packages/ui' }, ms: { specifier: '^2.0.0', version: '2.0.0(peer@1.0.0)' } } } },
    nested: { flow: { integrity: 'sha512-abc==', tarball: 'https://x/y.tgz' }, seq: ['a', 'b c', 'd'], empty: {}, hash: 'not # a comment' },
  });
  assert.deepEqual(parseYaml(''), {});
});

test("workspace patterns: npm's and yarn's package.json, pnpm-workspace.yaml; none is null", () => {
  assert.deepEqual(workspacePatterns({}, { workspaces: ['a/*'] }), ['a/*']);
  assert.deepEqual(workspacePatterns({}, { workspaces: { packages: ['b'] } }), ['b']);
  assert.deepEqual(workspacePatterns({ 'pnpm-workspace.yaml': 'packages:\n  - c/*\n' }, {}), ['c/*']);
  assert.deepEqual(workspacePatterns({ 'pnpm-workspace.yaml': '# no packages yet\n' }, null), []);
  assert.equal(workspacePatterns({}, { name: 'x' }), null);
  assert.equal(workspacePatterns({}, null), null);
});

test('workspace globs: * is one directory, ** any number, ! leaves out', () => {
  const patterns = ['apps/*', 'packages/**', '!packages/**/fixtures/*', './tools/cli/'];
  assert.ok(isWorkspace('apps/web', patterns));
  assert.ok(!isWorkspace('apps/web/nested', patterns));
  assert.ok(isWorkspace('packages/ui', patterns));
  assert.ok(isWorkspace('packages/group/ui', patterns));
  assert.ok(!isWorkspace('packages/ui/fixtures/a', patterns));
  assert.ok(isWorkspace('tools/cli', patterns));
  assert.ok(!isWorkspace('tools', patterns));
  assert.ok(!isWorkspace('apps/node_modules', patterns));
  assert.ok(!isWorkspace('', ['*']));
  // `**/` in the middle: any number of directories, none included.
  assert.ok(isWorkspace('apps/web', ['apps/**/web']));
  assert.ok(isWorkspace('apps/a/b/web', ['apps/**/web']));
  assert.ok(!isWorkspace('apps/a/webx', ['apps/**/web']));
  const files = { 'package.json': '{}', 'apps/web/package.json': '{}', 'apps/README.md': '', 'apps/docs/index.md': '', 'apps/node_modules/x/package.json': '{}' };
  assert.deepEqual(workspaceDirs(files, { workspaces: ['apps/*'] }), ['apps/web']);
  assert.deepEqual(workspaceDirs(files, null), []);
});

test("a directory of a monorepo's workspace loads the monorepo, and runs that workspace", async () => {
  const root = await loadProject(fixture('monorepo-workspaces'));
  assert.equal(root.app, undefined);
  assert.equal(root.path, fixture('monorepo-workspaces'));
  const app = await loadProject(fixture('monorepo-workspaces/apps/web'));
  assert.equal(app.app, 'apps/web');
  assert.equal(app.name, 'web');
  assert.equal(app.path, fixture('monorepo-workspaces'));
  assert.deepEqual(Object.keys(app.files).sort(), Object.keys(root.files).sort());
  // A directory with a package.json that is not one of the workspaces is a project of its own.
  const shared = await loadProject(fixture('monorepo-workspaces/shared/format'));
  assert.equal(shared.app, undefined);
  assert.deepEqual(Object.keys(shared.files).sort(), ['index.js', 'package.json']);
});
