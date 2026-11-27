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

test("a CommonJS package's synchronous require() of an ES module gets it evaluated in a project with top-level await (rolldown's of @emnapi/core, #172)", async () => {
  // The project awaits at the top level, so the host compiles every ES module as an async module.
  const esm = (path: string, source: string) => compileForRuntime(source, path, 'esm', { asyncModules: true });
  const install = {
    files: {
      'node_modules/core/package.json': JSON.stringify({ name: 'core', type: 'module', exports: { '.': './index.js' } }),
      // As @emnapi/core: an exported function reading a top-level const, and an import of its own.
      'node_modules/core/util.js': esm('/app/node_modules/core/util.js', `export const label = 'wasm';\n`),
      'node_modules/core/index.js': esm('/app/node_modules/core/index.js', `import { label } from './util.js';\nconst _WebAssembly = typeof WebAssembly !== 'undefined' ? WebAssembly : undefined;\nexport function instantiateSync() { return label + ':' + typeof _WebAssembly.Module; }\n`),
      // As rolldown's binding loader: CommonJS, requiring it synchronously and calling it at once.
      'node_modules/binding/package.json': JSON.stringify({ name: 'binding', main: 'index.cjs' }),
      'node_modules/binding/index.cjs': `module.exports = require('core').instantiateSync();\n`,
    },
    bundled: [],
  };
  const out = await h.runInstalled({ 'main.mjs': `const { default: binding } = await import('binding');\nconsole.log(binding);\n` }, install, '/app/main.mjs');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), 'wasm:function');
});

test('in a project with top-level await, an installed package whose modules import each other loads (@remix-run/route-pattern\'s cycle, #184)', async () => {
  const esm = (path: string, source: string) => compileForRuntime(source, path, 'esm', { asyncModules: true });
  const install = {
    files: {
      'node_modules/route-pattern/package.json': JSON.stringify({ name: 'route-pattern', type: 'module', exports: { '.': './index.js' } }),
      'node_modules/route-pattern/index.js': esm('/app/node_modules/route-pattern/index.js', `export { RoutePattern } from './route-pattern.js';\n`),
      'node_modules/route-pattern/route-pattern.js': esm(
        '/app/node_modules/route-pattern/route-pattern.js',
        `import { parse } from './parse.js';\nexport class RoutePattern {\n  constructor(source) { this.source = source; }\n  static parse(source) { return parse(source); }\n}\n`,
      ),
      'node_modules/route-pattern/parse.js': esm('/app/node_modules/route-pattern/parse.js', `import { RoutePattern } from './route-pattern.js';\nexport function parse(source) { return new RoutePattern(source); }\n`),
    },
    bundled: [],
  };
  const out = await h.runInstalled({ 'main.mjs': `await Promise.resolve();\nconst { RoutePattern } = await import('route-pattern');\nconsole.log(RoutePattern.parse('/users/:id').source);\n` }, install, '/app/main.mjs');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), '/users/:id');
});
