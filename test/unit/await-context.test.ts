import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { contextAwaits, mayRewrite, rewriteAwaits } from '../../src/node-runtime/await-context.ts';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';
import { oracleRewrite } from './await-oracle.ts';
import { programs } from './await-fuzz.ts';

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
  // What a review's differential fuzzing found the first scan got wrong:
  'const Mixin = (B) => class extends B {}; class Svc extends Mixin(class {}) { async handle() { await t(); } }',
  'class D extends f(class { async m() { await x; } }) { async n() { await y; } }',
  'async function outer() { const o = { async class() { await null; }, function: 1, async function() { await 2; } }; await null; }',
  'class El { static function = "f"; class = 1; class; function; async load() { await t(); } async class() { await u(); } }',
  'async function f(of) { const y = of / await t() / 1; const a = [of / 2, "/ await y", /"/]; for (const i of of / 2) await i; for (const k in of / 2) await k; }',
  'async function f(yield, let) { return yield / await a / let / await b; }',
  'async function f() { return await async + await static?.p; }',
  'async function f() { try { await a; } catch(e){await b} }',
  'async function f() { return { ...async (x) => { await x; } }; }',
  // A re-review's: a function expression in an extends clause; a `{` after a for head's `;`.
  'async function f() { class D extends function () { return async () => { await x; }; } { async m() { await y; } } }',
  'async function f() { class D extends async function () { await a; } {} }',
  'async function f() { for (; { async m() { await a; } }.m; ) await b; }',
  'async function f() { for (const x of xs) { await x; } for (const [a, b] of m) { if (a) { await b; } } for (const y of ys) { g(y); } await z; }',
  'async function f() { L: for (const x of xs) { for (const y of x) { await y; continue L; } } }',
  'async function f() { for (const x of xs) { await x; } for (const k in o) await k; }',
  'async function f() { for (const x of xs) await x; for (const y of await ys) g(y); for (const [a] of (b, c)) if (a) await a; else h(); await z; }',
  'async function f(of) { for (const of of xs) { await of; } for (const x of of / 2) await x; for (const { a = await r() } of g()) { h(a); } for ((await o).p of xs) await y; }',
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
  // A catch parameter's defaults run before the catch block restores the context; in `with`, the
  // names the rewrite adds would resolve through its object.
  assert.equal(rewriteAwaits('async function f() { try { await a; } catch ({ m = g() }) {} }'), null);
  assert.equal(rewriteAwaits('async function f() { try { await a; } catch ([m = 1]) {} }'), null);
  assert.equal(rewriteAwaits('async function f() { try { await a; } catch ({ [k()]: m }) {} }'), null);
  // Destructuring runs getters and iterators too.
  assert.equal(rewriteAwaits('async function f() { try { await a; } catch ({ message }) {} }'), null);
  assert.equal(rewriteAwaits('async function f() { try { await a; } catch ([m]) {} }'), null);

  assert.equal(rewriteAwaits('async function f(o) { with (o) { await a; } }'), null);
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
    const want = oracleRewrite(code);
    const out = rewriteAwaits(code);
    if (out !== null || want === null) assert.equal(out, want, file);
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

test('random async programs: the token scan rewrites as the parse does, or leaves the code to the lowering', () => {
  // esbuild's output of generated programs (await-fuzz.ts), plain and minified. A null is allowed
  // (the code is lowered); a rewrite that differs from the AST's is not.
  const next = programs(0x5eed);
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const src = next();
    let code: string;
    try {
      code = esbuild.transformSync(src, { loader: 'js', format: i % 2 ? 'cjs' : undefined, minify: i % 3 === 0, target: 'es2022', supported: { 'async-generator': false, 'for-await': false, 'dynamic-import': false }, logLevel: 'silent' }).code;
    } catch {
      continue; // not a valid program
    }
    let want: string | null;
    try {
      want = oracleRewrite(code);
    } catch {
      continue; // acorn reads a few of esbuild's outputs otherwise (sloppy-mode names)
    }
    const out = rewriteAwaits(code);
    // What the AST refuses the scan must refuse too; it may refuse more (bounds, `with`).
    if (want === null) assert.equal(out, null, code);
    if (out === null) continue;
    assert.equal(out, want, code);
    checked++;
  }
  assert.ok(checked > 200, `${checked} programs`);
});

test('large or await-dense code is lowered at once, not scanned (the host compiles 32 MB from an app)', () => {
  const unit = 'exports.f = async () => { await a; await b(await c); };\n';
  const dense = unit.repeat(Math.ceil((1 << 20) / unit.length)); // 1 MB, ~60,000 awaits
  const big = '/*' + 'x'.repeat(5 << 20) + '*/ async function f() { await a; }';
  assert.equal(mayRewrite(dense), false);
  assert.equal(mayRewrite(big), false);
  assert.equal(rewriteAwaits(big), null);
  const t0 = performance.now();
  const out = compileForRuntime(unit.repeat(Math.ceil((8 << 20) / unit.length)), '/app/dense.js', 'cjs');
  assert.doesNotMatch(out.slice(0, 2000), /__sandburg_ac/); // lowered
  assert.ok(performance.now() - t0 < 15_000, `${(performance.now() - t0).toFixed(0)} ms`);
});

test('a wrapped for-of iterable: built-in iterables and iterators pass through, anything whose iterator can close is wrapped', async () => {
  // The rewrite wraps the iterable of a for-of loop whose body is not in braces (awaitContext.i):
  // only an iterator with a return() needs it, so the built-ins V8 has fast paths for pass through.
  const { awaitContext } = await import('../../src/node-runtime/async-context.ts');
  const st = awaitContext.e();
  const arr = [1, 2];
  const set = new Set([1]);
  const map = new Map([[1, 2]]);
  const typed = new Uint8Array([1, 2]);
  const plain = (): [string, Iterable<unknown>][] => [
    ['array', arr],
    ['Set', set],
    ['Map', map],
    ['string', 'ab'],
    ['typed array', typed],
    ['map.entries()', map.entries()],
    ['map.values()', map.values()],
    ['set.values()', set.values()],
    ['arr.entries()', arr.entries()],
    ["string's iterator", 'ab'[Symbol.iterator]()],
  ];
  for (const [name, xs] of plain()) assert.equal(awaitContext.i(st, xs), xs, name);
  // A generator (its finally may run on an early exit), an iterator helper (it has a return()) and
  // an iterator with a return() of its own are wrapped.
  const gen = (function* () {})();
  assert.notEqual(awaitContext.i(st, gen), gen);
  const helper = (arr.values() as unknown as { map(f: (x: number) => number): Iterable<unknown> }).map((x) => x);
  assert.notEqual(awaitContext.i(st, helper), helper);
  const closing = Object.assign(arr.values(), { return: () => ({ done: true, value: undefined }) });
  assert.notEqual(awaitContext.i(st, closing), closing);
  // Something for-of would refuse is passed on, so for-of throws its own error.
  const notIterable = {} as Iterable<unknown>;
  assert.equal(awaitContext.i(st, notIterable), notIterable);
  assert.throws(() => {
    for (const _ of awaitContext.i(st, notIterable)) break;
  }, TypeError);
  // An array whose iterator is its own, or a subclass's, can close: wrapped.
  const own = Object.assign([1], { [Symbol.iterator]: function* () { yield 7; } });
  assert.notEqual(awaitContext.i(st, own), own);
  class Sub extends Array {
    *[Symbol.iterator](): ArrayIterator<number> {
      yield 9;
    }
  }
  const sub = new Sub();
  assert.notEqual(awaitContext.i(st, sub), sub);
  // A return() on a built-in iterator prototype, or on %IteratorPrototype% under them all (even one
  // that cannot be read without calling a getter), takes what iterates with it off the fast path.
  const prototypes: [string, object, string[]][] = [
    ['%ArrayIteratorPrototype%', Object.getPrototypeOf([][Symbol.iterator]()) as object, ['array', 'typed array', 'arr.entries()']],
    ['%SetIteratorPrototype%', Object.getPrototypeOf(new Set()[Symbol.iterator]()) as object, ['Set', 'set.values()']],
    ['%MapIteratorPrototype%', Object.getPrototypeOf(new Map()[Symbol.iterator]()) as object, ['Map', 'map.entries()', 'map.values()']],
    ['%StringIteratorPrototype%', Object.getPrototypeOf(''[Symbol.iterator]()) as object, ['string', "string's iterator"]],
    ['%IteratorPrototype%', Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as object, plain().map(([name]) => name)],
  ];
  for (const [protoName, proto, affected] of prototypes) {
    for (const descriptor of [{ value: () => ({ done: true }) }, { get: () => () => ({ done: true }) }]) {
      Object.defineProperty(proto, 'return', { configurable: true, ...descriptor });
      try {
        for (const [name, xs] of plain()) {
          const kept = awaitContext.i(st, xs) === xs;
          assert.equal(kept, !affected.includes(name), `${name}, with a return() on ${protoName} (${'get' in descriptor ? 'a getter' : 'a value'})`);
        }
      } finally {
        delete (proto as { return?: unknown }).return;
      }
    }
  }
  for (const [name, xs] of plain()) assert.equal(awaitContext.i(st, xs), xs, `${name}, once restored`);
});

test('a wrapped for-of iterable reads Symbol.iterator, next and return as for-of itself does', async () => {
  const { awaitContext } = await import('../../src/node-runtime/async-context.ts');
  const st = awaitContext.e();
  // Node: Symbol.iterator once per loop, next once per loop (the method, then called per step),
  // return only when the loop ends early (a break, a throw from the body, a rejected await in it),
  // and called once then.
  const counts = () => {
    const reads = { iterator: 0, next: 0, return: 0, closed: 0 };
    let i = 0;
    const iterator = {
      get next() {
        reads.next++;
        return () => ({ done: i++ > 1, value: i });
      },
      get return() {
        reads.return++;
        return () => {
          reads.closed++;
          return { done: true, value: undefined };
        };
      },
    };
    const iterable = {
      get [Symbol.iterator]() {
        reads.iterator++;
        return () => iterator;
      },
    };
    return { reads, iterable: iterable as Iterable<unknown> };
  };
  for (const wrap of [false, true]) {
    const as = wrap ? 'wrapped' : 'as it is';
    const loop = (iterable: Iterable<unknown>) => (wrap ? awaitContext.i(st, iterable) : iterable);
    const whole = counts();
    for (const _ of loop(whole.iterable)) { /* to the end */ }
    assert.deepEqual(whole.reads, { iterator: 1, next: 1, return: 0, closed: 0 }, `to the end, ${as}`);
    const early = counts();
    for (const _ of loop(early.iterable)) break;
    assert.deepEqual(early.reads, { iterator: 1, next: 1, return: 1, closed: 1 }, `break, ${as}`);
    const thrown = counts();
    assert.throws(() => {
      for (const _ of loop(thrown.iterable)) throw new Error('from the body');
    }, /from the body/);
    assert.deepEqual(thrown.reads, { iterator: 1, next: 1, return: 1, closed: 1 }, `a throw from the body, ${as}`);
    const rejected = counts();
    await assert.rejects(async () => {
      for (const _ of loop(rejected.iterable)) await Promise.reject(new Error('rejected'));
    }, /rejected/);
    assert.deepEqual(rejected.reads, { iterator: 1, next: 1, return: 1, closed: 1 }, `a rejected await, ${as}`);
  }
});

// Off by default: a timing test under `node --test`, which runs files in parallel, flakes.
// SANDBURG_PERF_TESTS=1 runs it (it caught the wrapper costing ~10x on arrays).
test('a wrapped for-of over an array or a Set runs at the speed of a plain one', { skip: !process.env.SANDBURG_PERF_TESTS }, () => {
  const time = (variant: 'native' | 'wrapped', kind: 'array' | 'set') => {
    const script = `
      import { awaitContext } from ${JSON.stringify(new URL('../../src/node-runtime/async-context.ts', import.meta.url).href)};
      globalThis.__sandburg_ac = awaitContext;
      const arr = Array.from({ length: 1000 }, (_, i) => i);
      const xs = ${kind === 'set' ? 'new Set(arr)' : 'arr'};
      const src = ${JSON.stringify(variant === 'native' ? 'let s = 0; for (let k = 0; k < n; k++) for (const x of xs) s += x; return s;' : 'const __sbac = __sandburg_ac.e(); let s = 0; for (let k = 0; k < n; k++) for (const x of __sandburg_ac.i(__sbac, xs)) s += x; return s;')};
      const f = new Function('xs', 'n', src);
      f(xs, 200);
      let best = Infinity;
      for (let r = 0; r < 7; r++) { const t0 = performance.now(); f(xs, 5000); best = Math.min(best, performance.now() - t0); }
      console.log(best);`;
    // Each measurement in a process of its own: in one, V8's feedback from one variant skews the next.
    return Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  };
  for (const kind of ['array', 'set'] as const) {
    const [a, b] = [time('native', kind), time('wrapped', kind)];
    assert.ok(b < a * 3 + 2, `${kind}: ${b.toFixed(1)} ms wrapped, ${a.toFixed(1)} ms native`);
  }
});
