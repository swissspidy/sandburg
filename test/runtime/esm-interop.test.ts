/**
 * ES module behaviour the conversion to CommonJS has to keep: an import still in its top-level await
 * (an installed package's, which the project's top-level-await scan does not see), and import.meta.resolve.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

/** An installed package as the host serves it: its ES module converted, as an async module when it awaits at the top level. */
const pkg = (name: string, source: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, type: 'module', exports: { '.': { import: './index.js' } } }),
  [`node_modules/${name}/index.js`]: compileForRuntime(source, `/app/node_modules/${name}/index.js`, 'esm'),
});

test("a project's ES module waits for an installed import's top-level await (@sveltejs/adapter-auto 8.0.1's), as in Node", async () => {
  const install = {
    files: {
      ...pkg('adapter', `const detected = await Promise.resolve('node');\nexport default () => ({ name: 'adapter-' + detected });\n`),
      ...pkg('plain', `export const ready = 'plain';\n`),
    },
    bundled: [],
  };
  const out = await h.runInstalled(
    {
      // Imported in this order: the plain package first, whose require ran once.
      'config.mjs': `import { ready } from 'plain';\nimport adapter from 'adapter';\nglobalThis.loads = (globalThis.loads ?? 0) + 1;\nexport default { ready, adapter: adapter() };\n`,
      // No top-level await in the project (Vite loads its config with import(), from its own code): the run's modules are not all async ones.
      'main.mjs': `import('./config.mjs').then(({ default: config }) => console.log(JSON.stringify([config, globalThis.loads])));\n`,
    },
    install,
    '/app/main.mjs',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), [{ ready: 'plain', adapter: { name: 'adapter-node' } }, 1]);
});

test("import.meta.resolve gives URLs as Node's does: a package's by its import conditions, relative ones whether or not they exist, built-ins with node:", async () => {
  const install = { files: pkg('dual', `export default 1;\n`), bundled: [] };
  const out = await h.runInstalled(
    {
      // An Astro 7.4 module resolves a package's file this way as it loads.
      'main.mjs': `console.log(JSON.stringify([import.meta.resolve('dual'), import.meta.resolve('./later.js'), import.meta.resolve('../up.js'), import.meta.resolve('fs'), import.meta.resolve('node:path'), import.meta.resolve('data:text/javascript,1')]));\n`,
    },
    install,
    '/app/main.mjs',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), ['file:///app/node_modules/dual/index.js', 'file:///app/later.js', 'file:///up.js', 'node:fs', 'node:path', 'data:text/javascript,1']);
});
