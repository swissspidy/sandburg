import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTopLevelAwait, toAsyncModule } from '../../src/adapters/node/tla.ts';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';

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
  assert.match(out, /await Promise\.all\(\[__sandburg_dep_0\.__sandburg_tla, __sandburg_dep_1\.__sandburg_tla, __sandburg_dep_2\.__sandburg_tla\]\);/);
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
