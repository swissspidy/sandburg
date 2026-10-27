import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFramework, loadProject, projectFromFiles } from '../../src/project.ts';
import { tempDir } from './temp-dir.ts';

const fixture = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));

test('loads a directory, skipping check files', async () => {
  const project = await loadProject(fixture);
  assert.equal(project.name, 'vite-react-counter');
  assert.equal(project.framework, 'vite');
  assert.ok('src/App.tsx' in project.files);
  assert.ok(!('checks.spec.ts' in project.files));
  assert.match(project.snapshotId, /^[0-9a-f]{64}$/);
});

test('detects frameworks', () => {
  assert.equal(detectFramework({}, { dependencies: { next: '15' } }), 'next');
  assert.equal(detectFramework({ 'vite.config.js': '' }, {}), 'vite');
  assert.equal(detectFramework({ 'index.html': '' }, null), 'static');
  assert.equal(detectFramework({}, {}), 'unknown');
});

test('content hash is stable and content-sensitive', () => {
  const a = projectFromFiles({ 'index.html': 'a', 'b.js': 'b' }, { name: 'x', path: 'x' });
  const b = projectFromFiles({ 'b.js': 'b', 'index.html': 'a' }, { name: 'x', path: 'x' });
  const c = projectFromFiles({ 'b.js': 'c', 'index.html': 'a' }, { name: 'x', path: 'x' });
  assert.equal(a.snapshotId, b.snapshotId);
  assert.notEqual(a.snapshotId, c.snapshotId);
});

test("build output (dist, build) is left out at the project's root only; installs, .git and tools' caches at any depth", async () => {
  const dir = tempDir('sandburg-project-');
  const files: Record<string, string> = {
    'package.json': '{}',
    'dist/index.js': 'built',
    'build/index.js': 'built',
    '.next/cache.json': '{}',
    'src/build/x.js': 'source',
    'src/dist/y.js': 'source',
    'packages/ui/dist/index.js': 'source',
    'src/.cache/z.js': 'cache',
    'src/node_modules/a/index.js': 'x',
    // A monorepo app's Next.js cache: large, and never source.
    'apps/web/.next/cache/webpack/0.pack': 'x'.repeat(6 * 1024 * 1024),
    'apps/web/.turbo/turbo-build.log': 'x',
    'src/.git/HEAD': 'x',
    'packages/web/.sandburg/x': 'x',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const project = await loadProject(dir);
  assert.deepEqual(Object.keys(project.files).sort(), ['package.json', 'packages/ui/dist/index.js', 'src/build/x.js', 'src/dist/y.js']);
});
