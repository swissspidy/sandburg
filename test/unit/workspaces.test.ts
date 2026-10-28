/**
 * A monorepo's workspaces (src/workspaces.ts) and the YAML pnpm writes (src/yaml-lite.ts), and how
 * a directory inside a monorepo loads (src/project.ts, ADR 0064).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isWorkspace, workspaceDirs, workspacePatterns } from '../../src/workspaces.ts';
import { parseYaml } from '../../src/yaml-lite.ts';
import { projectFromFiles } from '../../src/project.ts';
import { packageDirs } from '../../src/adapters/node/plan.ts';
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
  // pnpm 10 writes one for its settings alone (onlyBuiltDependencies): without `packages`, no workspaces.
  assert.equal(workspacePatterns({ 'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n' }, null), null);
  assert.deepEqual(workspacePatterns({ 'pnpm-workspace.yaml': 'packages: []\n' }, null), []);
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

test("a pnpm-workspace.yaml without packages leaves client/ and server/ installs as they were", () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ scripts: { dev: 'concurrently "npm run dev --prefix server" "npm run dev --prefix client"' } }),
      'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n',
      'client/package.json': '{"dependencies":{"vite":"^8.0.0"}}',
      'server/package.json': '{"dependencies":{"express":"^5.0.0"}}',
    },
    { name: 'split', path: 'split' },
  );
  assert.deepEqual(packageDirs(project), ['client', 'server']);
});

test('YAML: deep nesting does not overflow the stack; a __proto__ key is a key', () => {
  assert.doesNotThrow(() => parseYaml(`a: ${'['.repeat(200_000)}`));
  assert.doesNotThrow(() => parseYaml(`a: ${'{x: '.repeat(100_000)}`));
  assert.doesNotThrow(() => parseYaml(Array.from({ length: 20_000 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n')));
  const doc = parseYaml('__proto__:\n  polluted: yes\nflow: {__proto__: {polluted: yes}}\n') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(Object.keys(doc), ['__proto__', 'flow']);
  assert.equal((doc.flow as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a project's own .sandburg/ files are left out, however it is loaded", async () => {
  const files = { 'package.json': '{}', '.sandburg/workspace.json': '{"links":{}}', 'app/.sandburg/x': 'y', 'index.js': '' };
  assert.deepEqual(Object.keys(projectFromFiles(files, { name: 'x', path: 'x' }).files).sort(), ['index.js', 'package.json']);
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const json = join(mkdtempSync(join(tmpdir(), 'sandburg-json-')), 'tree.json');
  writeFileSync(json, JSON.stringify(files));
  assert.deepEqual(Object.keys((await loadProject(json)).files).sort(), ['index.js', 'package.json']);
});
