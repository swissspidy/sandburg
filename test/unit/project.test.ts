import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { detectFramework, loadProject, projectFromFiles } from '../../src/project.ts';

const fixture = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));

test('loads a directory, skipping check files', async () => {
  const project = await loadProject(fixture);
  assert.equal(project.name, 'vite-react-counter');
  assert.equal(project.framework, 'vite');
  assert.ok('src/App.tsx' in project.files);
  assert.ok(!('checks.spec.ts' in project.files));
  assert.match(project.contentHash, /^[0-9a-f]{64}$/);
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
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.contentHash, c.contentHash);
});
