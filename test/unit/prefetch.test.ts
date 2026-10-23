import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Installer } from '../../src/adapters/node/install.ts';
import { Prefetcher } from '../../src/adapters/node/prefetch.ts';

/** An install directory (installs/<key>/node_modules/…) with these files. */
async function install(files: Record<string, string>): Promise<{ installer: Installer; key: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-prefetch-'));
  const key = 'a'.repeat(24);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, 'installs', key, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { installer: new Installer(join(root, 'installs')), key, root };
}

test('a prefetch from an entry transforms what it requires, as the runtime resolves it', async () => {
  const { installer, key, root } = await install({
    'node_modules/tool/package.json': JSON.stringify({ name: 'tool', type: 'module', bin: 'bin/tool.js' }),
    'node_modules/tool/bin/tool.js': `import { run } from '../lib/run.js';\nrun();\n`,
    // ES imports and import() become require calls when transformed.
    'node_modules/tool/lib/run.js': `import dep from 'dep';\nimport sub from 'dual/feature';\nexport const run = () => import('./lazy.js').then(() => dep + sub);\n`,
    'node_modules/tool/lib/lazy.js': `export default 1;\n`,
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', main: 'main' }),
    'node_modules/dep/main.js': `module.exports = require('./data.json').n;\n`,
    'node_modules/dep/data.json': `{ "n": 1 }`,
    // "exports" with conditions: an ES module importer gets "import".
    'node_modules/dual/package.json': JSON.stringify({ name: 'dual', exports: { './feature': { import: './esm/feature.mjs', require: './cjs/feature.cjs' } } }),
    'node_modules/dual/esm/feature.mjs': `export default 2;\n`,
    'node_modules/dual/cjs/feature.cjs': `module.exports = 2;\n`,
    'node_modules/unused/index.js': `module.exports = 3;\n`,
  });
  try {
    const p = new Prefetcher(installer, key, await installer.index(key));
    p.add('node_modules/tool/bin/tool.js');
    await p.idle();
    assert.deepEqual(new Set(p.transformed), new Set(['node_modules/tool/bin/tool.js', 'node_modules/tool/lib/run.js', 'node_modules/tool/lib/lazy.js', 'node_modules/dep/main.js', 'node_modules/dual/esm/feature.mjs']));
    assert.ok(p.raw.has('node_modules/dep/data.json'));
    assert.ok(p.raw.has('node_modules/tool/package.json'));
    // Transformed for the runtime and cached: the request finds it.
    const served = await installer.file(key, 'node_modules/tool/lib/run.js');
    assert.match(served!.body.toString(), /require\("dep"\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
