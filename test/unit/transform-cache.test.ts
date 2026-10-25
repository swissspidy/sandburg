/** The project's transform cache (src/node-runtime/transform-cache.ts) that vite-plugin-solid's compiles go through. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';
import { createTransformCache } from '../../src/node-runtime/transform-cache.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function project(): Vfs {
  const vfs = new Vfs(() => {
    throw new Error('no remote files');
  });
  vfs.mkdir('/app/src', true);
  vfs.write('/app/src/app.tsx', enc('export default () => <p>hi</p>;'));
  vfs.write('/app/src/other.tsx', enc('export default () => <p>other</p>;'));
  return vfs;
}

const SOURCE = 'export default () => <p>hi</p>;';
const RESULT = { code: 'export default () => _tmpl$();', map: { version: 3, mappings: 'AAAA', sources: ['/app/src/app.tsx'] } };

test('a compile is found again for the same module, environment and source', () => {
  const vfs = project();
  const cache = createTransformCache(vfs, () => '/app');
  assert.equal(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), null);
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  assert.deepEqual(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), RESULT);
  // Kept with Vite's cache, which the next run of the project starts from.
  assert.equal(vfs.readdir('/app/node_modules/.vite/sandburg-transforms/vite-plugin-solid').length, 1);
  // A new cache over the same files (the next run) finds it.
  assert.deepEqual(createTransformCache(vfs, () => '/app').get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), RESULT);
});

test('another source, environment, module or plugin is a miss', () => {
  const cache = createTransformCache(project(), () => '/app');
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  assert.equal(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE + ' '), null);
  assert.equal(cache.get('vite-plugin-solid', '/app/src/app.tsx', true, SOURCE), null);
  assert.equal(cache.get('vite-plugin-solid', '/app/src/other.tsx', false, SOURCE), null);
  assert.equal(cache.get('other-plugin', '/app/src/app.tsx', false, SOURCE), null);
});

test('an entry is used only for the module it names (a planted or colliding file is a miss)', () => {
  const vfs = project();
  const cache = createTransformCache(vfs, () => '/app');
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  const dir = '/app/node_modules/.vite/sandburg-transforms/vite-plugin-solid';
  const [file] = vfs.readdir(dir);
  vfs.write(`${dir}/${file}`, enc(JSON.stringify({ id: '/app/src/other.tsx', ssr: false, source: SOURCE, code: 'evil()' })));
  assert.equal(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), null);
  vfs.write(`${dir}/${file}`, enc('not json'));
  assert.equal(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), null);
});

test('virtual modules and very large sources get no entry', () => {
  const vfs = project();
  const cache = createTransformCache(vfs, () => '/app');
  cache.set('vite-plugin-solid', '/@manifest/ssr/1792885751014/assets', true, 'export default {}', { code: 'x' });
  cache.set('vite-plugin-solid', 'virtual:routes', true, 'export default {}', { code: 'x' });
  const big = 'x'.repeat((1 << 20) + 1);
  vfs.write('/app/src/big.tsx', enc(big));
  cache.set('vite-plugin-solid', '/app/src/big.tsx', false, big, { code: 'x' });
  assert.equal(vfs.exists('/app/node_modules/.vite/sandburg-transforms'), false);
});

test("a module's variants (one id, other sources) each keep an entry", () => {
  const vfs = project();
  const cache = createTransformCache(vfs, () => '/app');
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, 'export default 1;', { code: 'one' });
  assert.deepEqual(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), RESULT);
  assert.deepEqual(cache.get('vite-plugin-solid', '/app/src/app.tsx', false, 'export default 1;'), { code: 'one' });
});

test('before the cache is kept, a run drops the entries it did not use', () => {
  const vfs = project();
  const dir = '/app/node_modules/.vite/sandburg-transforms/vite-plugin-solid';
  const first = createTransformCache(vfs, () => '/app');
  first.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  first.set('vite-plugin-solid', '/app/src/other.tsx', false, 'old source', { code: 'old' });
  first.prune();
  assert.equal(vfs.readdir(dir).length, 2);
  // The next run uses one entry and adds another: the third is dropped.
  const next = createTransformCache(vfs, () => '/app');
  assert.deepEqual(next.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), RESULT);
  next.set('vite-plugin-solid', '/app/src/other.tsx', false, 'new source', { code: 'new' });
  next.prune();
  assert.equal(vfs.readdir(dir).length, 2);
  assert.equal(next.get('vite-plugin-solid', '/app/src/other.tsx', false, 'old source'), null);
  // A run that used every entry changes nothing.
  const third = createTransformCache(vfs, () => '/app');
  assert.deepEqual(third.get('vite-plugin-solid', '/app/src/other.tsx', false, 'new source'), { code: 'new' });
  assert.deepEqual(third.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), RESULT);
  third.prune();
  assert.equal(vfs.readdir(dir).length, 2);
});

test('a run that used only some entries drops the rest; one that did not use the cache keeps them', () => {
  const vfs = project();
  const dir = '/app/node_modules/.vite/sandburg-transforms/vite-plugin-solid';
  const first = createTransformCache(vfs, () => '/app');
  first.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  first.set('vite-plugin-solid', '/app/src/other.tsx', false, 'stale', { code: 'stale' });
  createTransformCache(vfs, () => '/app').prune();
  assert.equal(vfs.readdir(dir).length, 2);
  const next = createTransformCache(vfs, () => '/app');
  next.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE);
  next.prune();
  assert.equal(vfs.readdir(dir).length, 1);
});

test("a plugin's own cache file is kept by name, and counts as used", () => {
  const vfs = project();
  const cache = createTransformCache(vfs, () => '/app');
  assert.equal(cache.getFile('nitro-rollup', 'cache.json'), null);
  cache.set('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE, RESULT);
  cache.setFile('nitro-rollup', 'cache.json', '{"modules":[]}');
  const next = createTransformCache(vfs, () => '/app');
  assert.equal(next.getFile('nitro-rollup', 'cache.json'), '{"modules":[]}');
  // A name cannot leave its plugin's directory.
  next.setFile('nitro-rollup', '../../../src/app.tsx', 'x');
  assert.equal(new TextDecoder().decode(vfs.read('/app/src/app.tsx')), SOURCE);
  next.prune();
  assert.equal(next.getFile('nitro-rollup', 'cache.json'), '{"modules":[]}');
  assert.equal(next.get('vite-plugin-solid', '/app/src/app.tsx', false, SOURCE), null);
});
