// What an immediate's callback queued (process.nextTick, promises, at any depth) all runs before the
// next immediate; and a timer that came due while an immediate ran comes before the next iteration's.
const { Readable } = require('stream');
const lines = [];
const cases = {
  'await x5'(log, done) {
    setImmediate(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); log('awaited 5'); });
    setImmediate(() => { log('next immediate'); done(); });
  },
  'await x10, then x10'(log, done) {
    setImmediate(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      let p = Promise.resolve();
      for (let i = 0; i < 10; i++) p = p.then(() => {});
      await p;
      log('chained 20');
    });
    setImmediate(() => { log('next immediate'); done(); });
  },
  'nextTick, promise, nextTick'(log, done) {
    setImmediate(() => process.nextTick(() => Promise.resolve().then(() => process.nextTick(() => Promise.resolve().then(() => log('nested'))))));
    setImmediate(() => { log('next immediate'); done(); });
  },
  'nested async functions'(log, done) {
    const c = async () => { await Promise.resolve(); await Promise.resolve(); return 'c'; };
    const b = async () => (await c()) + 'b';
    const a = async () => log((await b()) + 'a');
    setImmediate(a);
    setImmediate(() => { log('next immediate'); done(); });
  },
  'for await'(log, done) {
    setImmediate(async () => {
      const got = [];
      for await (const x of Readable.from([1, 2, 3])) got.push(x);
      log('read ' + got.join(''));
    });
    setImmediate(() => { log('next immediate'); done(); });
  },
  'middleware'(log, done) {
    // As Koa's compose: each middleware awaits the next.
    const compose = (mw) => (ctx) => { const go = (i) => (mw[i] ? Promise.resolve(mw[i](ctx, () => go(i + 1))) : Promise.resolve()); return go(0); };
    const app = compose([async (ctx, next) => { await next(); }, async (ctx, next) => { ctx.n++; await next(); }, async (ctx) => { await Promise.resolve(); ctx.n++; }]);
    setImmediate(async () => { const ctx = { n: 0 }; await app(ctx); log(`request ${ctx.n} handled`); });
    setImmediate(() => { log('other immediate'); done(); });
  },
  'timer due during an immediate'(log, done) {
    setTimeout(() => log('timer'), 2);
    setImmediate(() => {
      const end = Date.now() + 10;
      while (Date.now() < end);
      setImmediate(() => { log('inner immediate'); setTimeout(done, 20); });
    });
  },
};
void (async () => {
  for (const [name, run] of Object.entries(cases)) {
    const log = [];
    await new Promise((done) => setTimeout(() => run((s) => log.push(s), done), 5));
    await new Promise((r) => setTimeout(r, 20));
    lines.push(`${name}: ${log.join(', ')}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
})();
