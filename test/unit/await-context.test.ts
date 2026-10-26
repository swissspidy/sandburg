import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { contextAwaits, rewriteAwaits } from '../../src/node-runtime/await-context.ts';
import { oracleRewrite } from './await-oracle.ts';

/** esbuild's output as the host compiles code for the runtime: async functions stay native. */
const compiled = (code: string, format?: 'cjs') =>
  esbuild.transformSync(code, { loader: 'js', format, target: 'es2022', supported: { 'async-generator': false, 'for-await': false, 'dynamic-import': false }, logLevel: 'silent' }).code;

// Shapes the scan has to get right: what follows an await's operand, functions in every form, and
// what makes a `/` a regular expression or a division.
const CASES = [
  'async function f() { return await g(); }',
  'async function f(a) { const x = await a.b.c(1)[2]?.d?.(3)?.[4] + await (h, i) * 2; return x ? await j : await k; }',
  'const f = async () => await g();',
  'const f = async x => await x;',
  'const f = async (a, { b }, [c] = [1], ...d) => { await a; };',
  'const f = async () => `t${await g()}t${1}`;',
  'const o = { async m() { await 1; }, async [k]() { await 2; }, async "s"() { await 3; }, async: 1, b: async () => await 4, async() { return 5; }, get async() { return 6; } };',
  'class C { async m() { await 1; } static async s() { await super.x; } async #p() { await this.#q; } #q = 1; async() {} get [k]() { return 1; } x = async () => await 2; static { this.y = 1; } }',
  'async function f() { try { await g(); } catch (e) { await h(e); } finally { await i(); } try { await g(); } catch { } }',
  'async function f() { for (const x of await g()) { await x; } for await (const y of h()) await y; while (await g()) {} }',
  'async function f() { return [await a, { b: await b, [await c]: 1 }, await new D(await e), await typeof f, await -g, await !h, await void 0, await function () { return 1; }(), await class {}]; }',
  'async function f() { return await a++ + await b--; }',
  'async function f() { const r = /re[/]/g.test(await a) / 2; if (x) /y/.test(z); return r; }',
  'async function f() { x = a / await b / c; label: { await d; break label; } switch (await e) { case 1: { await g; } default: await h; } }',
  'async function f() { "use strict"; await a; }',
  'async function f() { function g() { var await = 1; return await; } return g() + await h; }',
  'async function f() { const g = function () { return 1 / 2; }; const h = () => { return /x/; }; await g(); }',
  'async function f() { return x?.5:await y; }',
  'async function f() { await (async () => { await a; })(); await async function () { await b; }(); }',
  'async function f() { tag`a${await b}c${await d}`; return await e`f`; }',
  'async function f() { a ? async () => await b : async () => { await c; }; }',
  'async function f() { return { a: async () => await b, c: async function () { await d; } }; }',
  'const x = { await: 1 }; const y = x.await; async function f() { return { await: await x.await }; }',
  'async function* g() { await a; yield b; }',
  'if (a) /re/.test(b); else c / d;',
  'async function f(){return await a}',
];

test('the token scan rewrites awaits as the parse does (acorn), and the result parses', () => {
  for (const src of CASES) {
    for (const format of [undefined, 'cjs'] as const) {
      const code = compiled(src, format);
      const out = rewriteAwaits(code);
      assert.equal(out, oracleRewrite(code), src);
      assert.doesNotThrow(() => new Function(out ?? ''), src);
    }
  }
});

test('the rewritten code returns what it did, with the context calls in between', async () => {
  const calls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.__sandburg_ac = {
    e: () => ({}),
    s: (_st: unknown, v: unknown) => (calls.push('s'), v),
    r: (_st: unknown, v: unknown) => (calls.push('r'), v),
    k: () => calls.push('k'),
    x: () => calls.push('x'),
  };
  try {
    const code = rewriteAwaits(compiled('exports.f = async (a) => { let n = 0; try { n += await a; await Promise.reject(1); } catch { n += await 2; } return n; };', 'cjs'))!;
    const m = { exports: {} as { f(a: unknown): Promise<number> } };
    new Function('exports', 'module', code)(m.exports, m);
    assert.equal(await m.exports.f(Promise.resolve(40)), 42);
    // Each await suspends (s) and resumes (r), but the rejected one, which resumes in the catch (k).
    assert.deepEqual(calls, ['s', 'r', 's', 'k', 's', 'r', 'x']);
  } finally {
    delete g.__sandburg_ac;
  }
});

test('code the scan does not understand is left to the lowering (null), and code without await is returned as it is', () => {
  assert.equal(rewriteAwaits('const x = 1;'), 'const x = 1;');
  assert.equal(rewriteAwaits('async function f() { await }'), null);
  assert.equal(rewriteAwaits('async function f() { await x; '), null);
  assert.equal(contextAwaits('async function f() { await x; '), null);
});

test('installed packages: the token scan rewrites as the parse does', () => {
  // Async code from this checkout's own dependencies, as esbuild outputs it for the runtime.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.c?js$/.test(name)) files.push(path);
    }
  };
  walk(join(import.meta.dirname, '../../node_modules/playwright-core/lib'));
  let checked = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!/\bawait\b/.test(src)) continue;
    const code = compiled(src, /^\s*(import|export)\b/m.test(src) ? 'cjs' : undefined);
    if (code.includes('import.meta')) continue; // not a script: the runtime gets these converted
    assert.equal(rewriteAwaits(code), oracleRewrite(code), file);
    checked++;
  }
  assert.ok(checked > 10, `${checked} files`);
});

test('the scan never throws and stays linear on arbitrary or crafted input (the host runs it on app code)', () => {
  // A fixed-seed soup of JavaScript's tokens, async and await among them.
  let seed = 0x2545f491;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const vocabulary = ['async', 'await', 'function', 'class', '=>', '(', ')', '{', '}', '[', ']', '`a${', '}`', '/', '/x/g', '"s"', "'t'", '1', '.5', 'x', '.', '?.', '?', ':', ',', ';', '++', '\n', 'catch', 'finally', 'try', 'case', 'default', 'static', 'get', '*', '=', '#p', 'new', 'typeof', '//c\n', '/*c*/'];
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 40);
    let code = 'async function f() { await x; ';
    for (let k = 0; k < n; k++) code += vocabulary[Math.floor(rnd() * vocabulary.length)] + ' ';
    const out = rewriteAwaits(code);
    assert.ok(out === null || typeof out === 'string');
  }
  // Thousands of awaits open at once: given up on (lowered instead), quickly.
  for (const code of [`async function f() { return ${'await '.repeat(100_000)}x; }`, `async function f() { return ${'await ('.repeat(50_000)}x${')'.repeat(50_000)}; }`]) {
    const t0 = performance.now();
    assert.equal(rewriteAwaits(code), null);
    assert.ok(performance.now() - t0 < 2000, `${(performance.now() - t0).toFixed(0)} ms`);
  }
  // Many awaits one after another: rewritten, in linear time.
  const many = `async function f() { ${'await x; '.repeat(50_000)} }`;
  const t0 = performance.now();
  assert.match(rewriteAwaits(many) ?? '', /__sandburg_ac\.r\(__sbac, await __sandburg_ac\.s\(__sbac, x\)\);/);
  assert.ok(performance.now() - t0 < 2000, `${(performance.now() - t0).toFixed(0)} ms`);
});
