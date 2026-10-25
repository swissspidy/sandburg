/** Vite's config bundles, kept from a project's last run (src/node-runtime/config-bundles.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';
import { createTransformCache } from '../../src/node-runtime/transform-cache.ts';
import { createConfigBundles } from '../../src/node-runtime/config-bundles.ts';
import { SOURCE_PATCHES } from '../../src/adapters/node/install-rules.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function project(): Vfs {
  const vfs = new Vfs(() => {
    throw new Error('no remote files');
  });
  vfs.mkdir('/app/config', true);
  vfs.write('/app/vite.config.ts', enc("import shared from './config/shared';\nexport default { ...shared };"));
  vfs.write('/app/config/shared.ts', enc('export default { base: "/" };'));
  vfs.write('/app/tsconfig.json', enc('{"compilerOptions":{}}'));
  return vfs;
}

/** A bundler that counts its bundles, with esbuild's dependencies (relative to the working directory). */
function bundler(code = 'export default { base: "/" };') {
  const made = { count: 0 };
  return { made, bundle: () => (made.count++, Promise.resolve({ code, dependencies: ['config/shared.ts', 'vite.config.ts'] })) };
}

test("a project's next run uses its last run's bundle", async () => {
  const vfs = project();
  const { made, bundle } = bundler();
  const first = await createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app')('/app/vite.config.ts', true, bundle);
  // The next run: a new runtime over the same files, with Vite's cache.
  const next = await createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app')('/app/vite.config.ts', true, bundle);
  assert.equal(made.count, 1);
  assert.deepEqual(next, first);
});

test('a bundle is made again when a file it was made from, or a setting next to one, changed', async () => {
  for (const [path, text] of [
    ['/app/vite.config.ts', 'export default {};'],
    ['/app/config/shared.ts', 'export default { base: "/x/" };'],
    ['/app/tsconfig.json', '{"compilerOptions":{"experimentalDecorators":true}}'],
    ['/app/config/tsconfig.json', '{}'], // one that was not there
    ['/app/package.json', '{"type":"module"}'],
  ]) {
    const vfs = project();
    const { made, bundle } = bundler();
    const bundles = () => createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app');
    await bundles()('/app/vite.config.ts', true, bundle);
    vfs.write(path, enc(text));
    await bundles()('/app/vite.config.ts', true, bundle);
    assert.equal(made.count, 2, path);
  }
});

test('a bundle is kept for its file, format and working directory only', async () => {
  const vfs = project();
  const { made, bundle } = bundler();
  const bundles = createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app');
  await bundles('/app/vite.config.ts', true, bundle);
  await bundles('/app/vite.config.ts', false, bundle);
  assert.equal(made.count, 2);
  await createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app/config')('/app/vite.config.ts', true, bundle);
  assert.equal(made.count, 3);
});

test("bundles that are not only code and files are not kept: findings to warn about, Vite 8's import.meta.resolve hook", async () => {
  for (const result of [
    { code: 'x', dependencies: ['vite.config.ts'], nativeIncompatibilities: [{ kind: 'global', name: '__dirname' }] },
    { code: 'const r = __vite_injected_original_import_meta_resolve("x");', dependencies: ['vite.config.ts'] },
    { code: 'x', dependencies: ['vite.config.ts'], extra: 1 },
    { code: 'x', dependencies: [] },
    { code: 'x', dependencies: ['missing.ts'] },
  ]) {
    const vfs = project();
    let made = 0;
    const bundles = () => createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app');
    for (let i = 0; i < 2; i++) await bundles()('/app/vite.config.ts', true, () => (made++, Promise.resolve(result as never)));
    assert.equal(made, 2, JSON.stringify(result));
  }
});

test('a tampered or foreign entry is not used', async () => {
  const vfs = project();
  const { made, bundle } = bundler();
  await createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app')('/app/vite.config.ts', true, bundle);
  const dir = '/app/node_modules/.vite/sandburg-transforms/vite-config';
  const [name] = vfs.readdir(dir);
  for (const text of ['not json', JSON.stringify({ fileName: '/app/other.config.ts', isESM: true, cwd: '/app', inputs: {}, bundle: { code: 'evil', dependencies: [] } })]) {
    vfs.write(`${dir}/${name}`, enc(text));
    const out = await createConfigBundles(vfs, createTransformCache(vfs, () => '/app'), () => '/app')('/app/vite.config.ts', true, bundle);
    assert.equal(out.code, 'export default { base: "/" };');
  }
  assert.equal(made.count, 3);
});

test("Vite's bundleConfigFile asks the hook, in Vite 6's and Vite 8's builds", () => {
  const patch = SOURCE_PATCHES[0];
  // The function as Vite 6.4 and 8.3 declare it (their dist/node/chunks).
  for (const source of ['\nasync function bundleConfigFile(fileName, isESM) {\n  const isModuleSyncConditionEnabled = 1;\n}\n', '\nasync function bundleConfigFile(fileName, isESM) {\n\tlet importMetaResolverRegistered = false;\n}\n']) {
    const out = source.replace(patch.from, patch.to);
    assert.match(out, /sandburg\.configBundles/);
    assert.match(out, /async function sandburgBundleConfigFile\(fileName, isESM\) \{/);
    // A file patched twice (the browser's install, then its compiler) is patched once.
    assert.equal(out.replace(patch.from, patch.to), out);
  }
  assert.ok(patch.file.test('node_modules/vite/dist/node/chunks/dep-CkSfqg8D.js'));
  assert.ok(patch.file.test('node_modules/@angular/build/node_modules/vite/dist/node/chunks/node.js'));
  assert.ok(!patch.file.test('node_modules/vite-plugin-x/dist/node/chunks/a.js'));
});
