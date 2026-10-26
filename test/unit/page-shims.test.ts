import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { compileForRuntime } from '../../src/adapters/node/compile.ts';
import { AWAIT_CONTEXT_GLOBAL } from '../../src/node-runtime/names.ts';

/** A page with only ws-shim.js run in it, as sw.js inserts it into every app page. */
function page(): vm.Context {
  const ctx = vm.createContext({ XMLHttpRequest: class { open() {} }, WebSocket: class {}, fetch: () => {} });
  ctx.window = ctx;
  ctx.top = {};
  vm.runInContext(readFileSync(new URL('../../src/adapters/node/ws-shim.js', import.meta.url), 'utf8'), ctx);
  return ctx;
}

/** A module's export as the runtime compiles it, and its source as Function.prototype.toString gives it. */
function compiledSource(code: string): string {
  const out = compileForRuntime(code, '/app/node_modules/cli/dist/client.mjs', 'esm');
  const module = { exports: {} as Record<string, () => unknown> };
  new Function('module', 'exports', 'require', out)(module, module.exports, () => ({}));
  return module.exports.client.toString();
}

// @nuxt/cli 4 sends its loading screen's client to the page as `(${client.toString()})(…)`: the
// compiled form, whose awaits call the runtime's await-context helper (await-context.ts).
test('page shims: a compiled async function sent to the page as source runs there', async () => {
  const source = compiledSource(`export function client(options) {
    const attempt = async () => {
      try {
        const text = await (await options.fetch()).text();
        for (const part of [text]) await options.seen(part);
        return text;
      } catch (e) {
        return 'caught ' + e.message;
      }
    };
    return attempt();
  }`);
  assert.match(source, new RegExp(`\\b${AWAIT_CONTEXT_GLOBAL}\\.`), 'the awaits are rewritten');
  const seen: string[] = [];
  const ctx = page();
  ctx.options = { fetch: async () => ({ text: async () => 'ready' }), seen: async (s: string) => void seen.push(s) };
  assert.equal(await vm.runInContext(`(${source})(options)`, ctx), 'ready');
  assert.deepEqual(seen, ['ready']);
  ctx.options = { fetch: async () => Promise.reject(new Error('offline')) };
  assert.equal(await vm.runInContext(`(${source})(options)`, ctx), 'caught offline');
});

test('page shims: the await-context helper is a pass-through that the page cannot replace', () => {
  const ctx = page();
  const helper = vm.runInContext(AWAIT_CONTEXT_GLOBAL, ctx) as Record<string, (...args: unknown[]) => unknown>;
  const state = helper.e();
  assert.equal(helper.s(state, 1), 1);
  assert.equal(helper.r(state, 2), 2);
  const it = [3];
  assert.equal(helper.i(state, it), it);
  assert.equal(helper.k(state), undefined);
  assert.equal(helper.x(state), undefined);
  assert.ok(Object.isFrozen(helper));
});
