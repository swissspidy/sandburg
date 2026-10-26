import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

// The expected output is Node's (v22 and v24) for the same program.
test('AsyncLocalStorage across native awaits: concurrent calls, rejections, methods, arrows, generators, for await, no leaks', async () => {
  const program = `
    const { AsyncLocalStorage } = require('async_hooks');
    const als = new AsyncLocalStorage();
    const out = [];
    const log = (tag) => out.push(tag + '=' + (als.getStore() ?? '-'));
    const tick = () => new Promise((r) => setTimeout(r, 1));
    async function deep(n) { await null; log('deep' + n); if (n) await deep(n - 1); await tick(); log('deepAfter' + n); }
    async function rejecting() { await null; throw new Error('x'); }
    class Svc { async m() { await null; log('method'); return als.getStore(); } static async s() { await tick(); log('static'); } }
    const obj = { async m() { await Promise.resolve(); log('objMethod'); } };
    async function* gen() { await null; log('gen1'); yield 1; await tick(); log('gen2'); yield 2; }
    async function main() {
      await Promise.all(['A', 'B'].map((s) => als.run(s, async () => {
        await deep(1);
        try { await rejecting(); } catch { log('catch' + s); }
        try { await rejecting(); } finally { log('finally' + s); await null; log('afterFinally' + s); }
      }).catch(() => log('outer'))));
      await als.run('C', async () => {
        const arrow = async () => (await null, als.getStore());
        out.push('arrow=' + (await arrow()));
        out.push('method=' + (await new Svc().m()));
        await Svc.s();
        await obj.m();
        for await (const v of gen()) log('for' + v);
        const r = await Promise.all([1, 2].map(async (i) => { await tick(); return i + ':' + als.getStore(); }));
        out.push('all=' + r.join(','));
        setTimeout(() => log('timer'), 0);
        await tick(); await tick();
      });
      // Callbacks scheduled outside any context see none, around a function that resumes in one.
      als.run('D', () => { (async () => { await null; await null; log('D'); })(); });
      await Promise.resolve().then(() => log('root1')).then(() => log('root2')).then(() => log('root3'));
      log('main');
      await als.run('E', async () => { als.enterWith('F'); await null; log('enterWith'); });
      log('afterE');
      console.log(out.join(' '));
    }
    main();`;
  const out = await h.run({ 'main.js': program }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? '');
  assert.equal(
    out.stdout.trim(),
    'deep1=A deep1=B deep0=A deep0=B deepAfter0=A deepAfter0=B deepAfter1=A catchA=A finallyA=A afterFinallyA=A outer=- deepAfter1=B catchB=B finallyB=B afterFinallyB=B outer=- ' +
      'arrow=C method=C method=C static=C objMethod=C gen1=C for1=C gen2=C for2=C all=1:C,2:C timer=C root1=- D=D root2=- root3=- main=- enterWith=F afterE=-',
  );
});

test('native awaits take the ticks they take in Node', async () => {
  const program = `
    const out = [];
    async function a() { out.push('a1'); await null; out.push('a2'); await null; out.push('a3'); }
    async function b() { out.push('b1'); await a(); out.push('b2'); }
    b();
    Promise.resolve().then(() => out.push('p1')).then(() => out.push('p2')).then(() => out.push('p3')).then(() => out.push('p4')).then(() => console.log(out.join(' ')));`;
  const out = await h.run({ 'main.js': program }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? '');
  assert.equal(out.stdout.trim(), 'b1 a1 a2 p1 a3 p2 b2 p3 p4');
});

test('an async function stays native: its stack has async frames, and its source is what the host compiled', async () => {
  const program = `
    async function inner() { await null; throw new Error('boom'); }
    async function outer() { await inner(); }
    outer().catch((e) => console.log(/at async outer/.test(e.stack), String(inner).startsWith('async function inner()')));`;
  const out = await h.run({ 'main.js': program }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? '');
  assert.equal(out.stdout.trim(), 'true true');
});
