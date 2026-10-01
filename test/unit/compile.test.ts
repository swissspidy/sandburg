import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';

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

test('the same chunk written again with one module changed compiles that module again', () => {
  compileForRuntime(chunk('10'), '/app/.next/server/chunk2.js', 'cjs');
  const out = compileForRuntime(chunk('20'), '/app/.next/server/chunk2.js', 'cjs');
  assert.match(out, /Promise\.resolve\(20\)/);
});
