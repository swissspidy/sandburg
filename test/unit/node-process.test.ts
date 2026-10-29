/** The page's side of a runtime (src/adapters/node/process.ts): requests it forwards are always answered. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NodeProcess } from '../../src/adapters/node/process.ts';
import type { FromWorker } from '../../src/node-runtime/messages.ts';

Object.assign(globalThis, { location: { origin: 'https://sandbox.test', host: 'sandbox.test' }, document: { cookie: '' } });

/** A NodeProcess on a runtime worker that only takes messages (ended with the test), and what it hears back from it. */
function start(t: TestContext) {
  const worker = { postMessage() {}, terminate() {}, onmessage: null, onerror: null } as unknown as Worker;
  const proc = new NodeProcess({ files: {}, env: {}, installKey: null, nodeModules: null, log: () => {}, worker });
  t.after(() => proc.terminate());
  const from = (m: Partial<FromWorker>) => (worker.onmessage as (e: { data: unknown }) => void)({ data: m });
  const ask = () => {
    const got: string[] = [];
    const reply = { postMessage: (m: { type: string; message?: string }) => got.push(m.message ? `${m.type}: ${m.message}` : m.type), close: () => got.push('closed') };
    proc.request(3000, { method: 'GET', url: '/', headers: [], body: null }, reply);
    return got;
  };
  return { proc, from, ask };
}

test('requests waiting when the runtime crashes or is stopped get an error, as do those sent after', (t) => {
  const crashed = start(t);
  crashed.from({ type: 'listening', port: 3000 });
  const first = crashed.ask();
  const second = crashed.ask();
  crashed.proc.fail(new Error('runtime worker error: boom\nat x'));
  for (const got of [first, second, crashed.ask()]) assert.deepEqual(got, ['error: the app crashed: runtime worker error: boom', 'closed']);
  assert.equal(crashed.proc.activity().inflight, 0);

  // A run's page stops its runtime while the service worker still sends it requests.
  const stopped = start(t);
  stopped.from({ type: 'listening', port: 3000 });
  const waiting = stopped.ask();
  stopped.proc.terminate();
  for (const got of [waiting, stopped.ask()]) assert.deepEqual(got, ['error: the app stopped', 'closed']);
  assert.equal(stopped.proc.activity().inflight, 0);
});

test('a request waiting when the program exits is left to the runtime (a child process may still answer it)', (t) => {
  const { proc, from, ask } = start(t);
  from({ type: 'listening', port: 3000 });
  const got = ask();
  from({ type: 'exit', code: 0 });
  assert.deepEqual(got, []);
  from({ type: 'response-full', id: 1, status: 200, statusText: 'OK', headers: [], body: new ArrayBuffer(0) });
  assert.deepEqual(got, ['full', 'closed']);
  assert.equal(proc.activity().inflight, 0);
});

test('a request that failed in the runtime closes its port', (t) => {
  const { proc, from, ask } = start(t);
  from({ type: 'listening', port: 3000 });
  const got = ask();
  from({ type: 'response-error', id: 1, message: 'socket hang up' });
  assert.deepEqual(got, ['error: socket hang up', 'closed']);
  assert.equal(proc.activity().inflight, 0);
});

test('a runtime that fails after its program exited answers new requests with an error at once', (t) => {
  const { proc, from, ask } = start(t);
  from({ type: 'listening', port: 3000 });
  from({ type: 'exit', code: 0 });
  // The page's compiler fails (browser.ts), after the program exited while a child process serves.
  proc.fail(new Error("the page's compiler failed: worker error"));
  assert.deepEqual(ask(), ["error: the app crashed: the page's compiler failed: worker error", 'closed']);
  assert.equal(proc.activity().inflight, 0);
});

test("a response for a request the page does not wait for (another runtime's, or one answered already) sets no cookie", (t) => {
  const { from, ask } = start(t);
  const doc = globalThis as unknown as { document: { cookie: string } };
  doc.document.cookie = '';
  from({ type: 'listening', port: 3000 });
  for (const id of [-42, 2]) {
    from({ type: 'response-start', id, status: 200, statusText: 'OK', headers: [['set-cookie', 'stray=1']] });
    from({ type: 'response-full', id, status: 200, statusText: 'OK', headers: [['set-cookie', 'stray=1']], body: new ArrayBuffer(0) });
  }
  assert.equal(doc.document.cookie, '');
  // The page's own request's still does.
  const got = ask();
  from({ type: 'response-full', id: 1, status: 200, statusText: 'OK', headers: [['set-cookie', 'mine=1; HttpOnly']], body: new ArrayBuffer(0) });
  assert.deepEqual(got, ['full', 'closed']);
  assert.equal(doc.document.cookie, 'mine=1');
});

test("a runtime that does not say what the app read is waited for no longer than asked, and not remembered after", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { proc, from } = start(t);
  const unanswered = proc.projectReads([{ name: 'dayjs', from: 'src/a.ts' }], 3_000);
  assert.equal(proc.projectReadsWaiting, 1);
  t.mock.timers.tick(3_000);
  assert.equal(await unanswered, null);
  assert.equal(proc.projectReadsWaiting, 0);
  // An answer in time is the answer (the id is the one sent: the second asked).
  const answered = proc.projectReads([], 3_000);
  from({ type: 'project-reads', id: 2, reads: ['src/a.ts'], installed: [] });
  assert.deepEqual(await answered, { reads: ['src/a.ts'], installed: [] });
  assert.equal(proc.projectReadsWaiting, 0);
});
