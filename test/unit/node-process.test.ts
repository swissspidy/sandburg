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

test('requests waiting when the program exits or crashes get an error, and their ports are closed', (t) => {
  const { proc, from, ask } = start(t);
  from({ type: 'listening', port: 3000 });
  const waiting = ask();
  from({ type: 'exit', code: 1 });
  assert.deepEqual(waiting, ['error: the app exited with code 1', 'closed']);
  assert.equal(proc.activity().inflight, 0);

  const other = start(t);
  other.from({ type: 'listening', port: 3000 });
  const first = other.ask();
  const second = other.ask();
  other.proc.fail(new Error('runtime worker error: boom\nat x'));
  for (const got of [first, second]) assert.deepEqual(got, ['error: the app crashed: runtime worker error: boom', 'closed']);
});

test('a request that failed in the runtime closes its port', (t) => {
  const { proc, from, ask } = start(t);
  from({ type: 'listening', port: 3000 });
  const got = ask();
  from({ type: 'response-error', id: 1, message: 'socket hang up' });
  assert.deepEqual(got, ['error: socket hang up', 'closed']);
  assert.equal(proc.activity().inflight, 0);
});
