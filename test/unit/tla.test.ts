import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTopLevelAwait, toAsyncModule } from '../../src/adapters/node/tla.ts';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';
import './await-context-stub.ts'; // compiled code runs here

test('hasTopLevelAwait ignores await inside functions', () => {
  assert.equal(hasTopLevelAwait('const x = await f();'), true);
  assert.equal(hasTopLevelAwait('for await (const x of y) {}'), true);
  assert.equal(hasTopLevelAwait('if (a) { await b(); }'), true);
  assert.equal(hasTopLevelAwait('async function f() { await g(); }\nconst h = async () => await i();'), false);
  assert.equal(hasTopLevelAwait('const s = "await";'), false);
});

test('toAsyncModule keeps imports/exports static and runs the body after dependencies', () => {
  const out = toAsyncModule(`import { open } from './db.js';
import * as fs from 'node:fs';
export * from './types.js';
const { a, b: [c] } = await open();
export let count = a + c;
export class Store {}
export function helper() { return count; }
export default await fs.promises.readFile('x');
console.log('ready');`);
  assert.match(out, /^import \{ open \} from '\.\/db\.js';/);
  assert.match(out, /export function helper\(\) \{ return count; \}/);
  assert.match(out, /let a, c, count, Store, __sandburg_default;/);
  assert.match(out, /export \{ count, Store, __sandburg_default as default \};/);
  assert.match(out, /const __sandburg_pending = \[__sandburg_dep_0\.__sandburg_tla, __sandburg_dep_1\.__sandburg_tla, __sandburg_dep_2\.__sandburg_tla\]\.filter\(\(p\) => p\);/);
  assert.match(out, /export let __sandburg_tla = \(async \(\) => \{\nif \(__sandburg_pending\.length\) await Promise\.all\(__sandburg_pending\);/);
  assert.match(out, /\(\{ a, b: \[c\] \} = await open\(\)\);/);
  assert.match(out, /Store = class Store \{\};/);
  assert.match(out, /__sandburg_default = \(await fs\.promises\.readFile\('x'\)\);/);
});

test('compileForRuntime turns top-level await into CommonJS that exports the evaluation promise', async () => {
  const cjs = compileForRuntime(`export const value = await Promise.resolve(42);`, '/app/a.mjs', 'esm');
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', 'require', cjs)(module, module.exports, () => ({}));
  assert.equal(module.exports.value, undefined);
  await module.exports.__sandburg_tla;
  assert.equal(module.exports.value, 42);
  // TypeScript with top-level await.
  const ts = compileForRuntime(`const n: number = await Promise.resolve(1);\nexport { n };`, '/app/b.ts', 'ts');
  assert.match(ts, /__sandburg_tla/);
  // Without top-level await nothing changes.
  assert.doesNotMatch(compileForRuntime(`export const x = 1;`, '/app/c.mjs', 'esm'), /__sandburg_tla/);
});

/** Runs compiled CommonJS with the given modules to require, as the runtime's loader does. */
function run(cjs: string, modules: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', 'require', cjs)(module, module.exports, (id: string) => modules[id]);
  return module.exports;
}

test('an async module without an await of its own runs its body at once when nothing it imports is still evaluating (#172)', () => {
  // As @emnapi/core: an exported function that reads a top-level const, called by a synchronous require().
  const code = `import { helper } from './dep.js';\nconst _WebAssembly = typeof WebAssembly !== 'undefined' ? WebAssembly : undefined;\nexport function instantiate() { return _WebAssembly === WebAssembly && helper(); }`;
  const settled = run(compileForRuntime(code, '/app/core.mjs', 'esm', { asyncModules: true }), { './dep.js': { helper: () => 'ok', __sandburg_tla: undefined } });
  assert.equal(settled.__sandburg_tla, undefined);
  assert.equal((settled.instantiate as () => unknown)(), 'ok');
  // A CommonJS import (no __sandburg_tla at all) is not waited for either.
  const cjsDep = run(compileForRuntime(code, '/app/core.mjs', 'esm', { asyncModules: true }), { './dep.js': { helper: () => 'ok' } });
  assert.equal((cjsDep.instantiate as () => unknown)(), 'ok');
});

test('an async module waits for an import still evaluating, then nothing is left to wait for (#172)', async () => {
  let finish!: () => void;
  const dep = { value: 0, __sandburg_tla: new Promise<void>((resolve) => (finish = resolve)) as Promise<void> | undefined };
  const exports = run(compileForRuntime(`import { value } from './dep.js';\nexport const seen = value;`, '/app/a.mjs', 'esm', { asyncModules: true }), { './dep.js': dep });
  assert.equal(exports.seen, undefined);
  dep.value = 7;
  finish();
  await exports.__sandburg_tla;
  assert.equal(exports.seen, 7);
  await Promise.resolve();
  assert.equal(exports.__sandburg_tla, undefined);
  // One with an await of its own: evaluated, its __sandburg_tla is undefined too; a rejection stays for its importers.
  const own = run(compileForRuntime(`export const v = await Promise.resolve(1);`, '/app/b.mjs', 'esm'));
  await own.__sandburg_tla;
  await Promise.resolve();
  assert.deepEqual([own.v, own.__sandburg_tla], [1, undefined]);
  const failing = run(compileForRuntime(`await Promise.reject(new Error('boom'));`, '/app/c.mjs', 'esm'));
  await assert.rejects(failing.__sandburg_tla as Promise<unknown>, /boom/);
  assert.notEqual(failing.__sandburg_tla, undefined);
});
