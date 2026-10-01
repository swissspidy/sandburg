import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileForRuntime, compileForRuntimeAsync, projectHasTopLevelAwait, projectHasTopLevelAwaitAsync } from '../../src/adapters/node/compile.ts';

// A webpack dev chunk: modules as eval("<source>") literals, and code of its own around them.
const chunk = (body: string) => `"use strict";
exports.modules = {
  "./a.js": ((module) => { eval(${JSON.stringify(`module.exports = async function load() { return await Promise.resolve(${body}); };\n//# sourceURL=webpack-internal:///./a.js`)}); }),
  "./b.js": ((module) => { eval(${JSON.stringify('module.exports = 2;')}); }),
};
exports.run = async () => (await Promise.resolve(1));
`;

test('a webpack dev chunk: async code lowered inside its eval literals and around them', async () => {
  const out = compileForRuntime(chunk('1'), '/app/.next/server/chunk.js', 'cjs');
  const evals = [...out.matchAll(/\beval\(("(?:[^"\\\n]|\\.)*")\)/g)].map((m) => JSON.parse(m[1]) as string);
  assert.equal(evals.length, 2);
  assert.doesNotMatch(evals[0], /\basync function\b|\bawait\b/); // lowered
  assert.match(evals[0], /\/\/# sourceURL=webpack-internal:\/\/\/\.\/a\.js$/); // kept last
  assert.equal(evals[1], 'module.exports = 2;'); // nothing to lower: as it was
  assert.doesNotMatch(out.replace(/\beval\(("(?:[^"\\\n]|\\.)*")\)/g, ''), /\basync\b|\bawait\b/); // the code around them too
  assert.doesNotMatch(out, /__sandburg_eval_/);
  const exports: Record<string, unknown> = {};
  new Function('exports', 'module', out)(exports, { exports });
  assert.equal(await (exports.run as () => Promise<number>)(), 1);
  const a: { exports?: () => Promise<number> } = {};
  (exports.modules as Record<string, (m: object) => void>)['./a.js'](a);
  assert.equal(await a.exports!(), 1);
});

test('an eval literal whose only dynamic code is import() is lowered too', () => {
  const src = `exports.m = ((module) => { eval(${JSON.stringify('module.exports = () => import("./x.js");\n//# sourceURL=webpack-internal:///./i.js')}); });`;
  const out = compileForRuntime(src, '/app/.next/server/chunk3.js', 'cjs');
  const inner = JSON.parse(/\beval\(("(?:[^"\\\n]|\\.)*")\)/.exec(out)![1]) as string;
  assert.doesNotMatch(inner, /\bimport\s*\(/);
  assert.match(inner, /Symbol\.for\("sandburg\.esm"\)/); // the interop patch, inside the literal and quoted with it
  assert.doesNotThrow(() => new Function('exports', out));
});

test('the same chunk written again with one module changed compiles that module again', () => {
  compileForRuntime(chunk('10'), '/app/.next/server/chunk2.js', 'cjs');
  const out = compileForRuntime(chunk('20'), '/app/.next/server/chunk2.js', 'cjs');
  assert.match(out, /Promise\.resolve\(20\)/);
});

test('an ES module with a hashbang (a bin script) compiles to code that runs', () => {
  const out = compileForRuntime('#!/usr/bin/env node\nimport process from "node:process";\nexport const x = process.argv.length;\n', '/app/node_modules/tool/bin/index.js', 'esm');
  assert.doesNotMatch(out, /#!/);
  assert.doesNotThrow(() => new Function('require', 'exports', 'module', out));
});

test('compiled in a browser (esbuild-wasm): the same output as on the host, and the same top-level await scan', async () => {
  const wasm = await import('esbuild-wasm');
  await wasm.initialize({});
  try {
    const transform = async (code: string, options: Parameters<typeof wasm.transform>[1]) => (await wasm.transform(code, options)).code;
    const samples: [string, string, 'esm' | 'cjs' | 'ts'][] = [
      ['import { a } from "./a.js";\nexport const b = async () => await a();\nconst require = 1;\n', '/app/x.mjs', 'esm'],
      ['const x: number = 1;\nexport default async function f() { for await (const y of []) {} return x; }\n', '/app/y.ts', 'ts'],
      [chunk('7'), '/app/.next/server/chunk4.js', 'cjs'],
    ];
    for (const [code, path, kind] of samples) {
      // The WebAssembly build first: eval literals are cached once lowered, and must be lowered by it.
      const inBrowser = await compileForRuntimeAsync(code, path, kind, {}, transform);
      assert.equal(inBrowser, compileForRuntime(code, path, kind), path);
    }
    const files = { 'a.ts': 'const x: number = await Promise.resolve(1);\nexport { x };\n', 'b.js': 'async function f() { await 1; }\n' };
    assert.equal(await projectHasTopLevelAwaitAsync(files, transform), projectHasTopLevelAwait(files));
    assert.equal(await projectHasTopLevelAwaitAsync({ 'b.js': files['b.js'] }, transform), false);
  } finally {
    await wasm.stop();
  }
});
