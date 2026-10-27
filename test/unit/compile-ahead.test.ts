import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';

/**
 * The helper, stubbed: it records what it is sent and answers as a test says (in this thread, since
 * the runtime blocks on its answer). `run` says it runs; `answer` settles a file's compile.
 */
type Sent = { path: string; bytes: Uint8Array; shared: SharedArrayBuffer };
const sent: Sent[] = [];
let answer: ((m: Sent) => string | null | undefined) | null = null;
let alive: SharedArrayBuffer | null = null;

function settle(shared: SharedArrayBuffer, out: string | null): void {
  const state = new Int32Array(shared, 0, 2);
  if (out !== null) {
    const bytes = new TextEncoder().encode(out);
    shared.grow(8 + bytes.length);
    new Uint8Array(shared, 8).set(bytes);
    Atomics.store(state, 1, bytes.length);
  }
  Atomics.store(state, 0, out === null ? 2 : 1);
}

class StubWorker {
  onerror: ((e: { preventDefault(): void }) => void) | null = null;
  postMessage(m: { alive?: SharedArrayBuffer } & Partial<Sent>): void {
    if (m.alive) {
      alive = m.alive;
      return;
    }
    const message = m as Sent;
    sent.push(message);
    const out = answer?.(message);
    // undefined: no answer (a helper that hangs)
    if (out !== undefined) settle(message.shared, out);
  }
}
(globalThis as { Worker?: unknown }).Worker = StubWorker;
const { compileAhead, compileWhenWritten, compiledAhead } = await import('../../src/node-runtime/compile-ahead.ts');

const DIR = '/app/.next/server';
const tick = () => new Promise((r) => setTimeout(r, 0));
/** The program's waits for a compile (Atomics.wait, as compiledAhead blocks), counted. */
const waits = (t: TestContext) => t.mock.method(Atomics, 'wait').mock;
const vfs = new Vfs(() => {
  throw new Error('no remote files');
});
vfs.mkdir(DIR, true);
// What worker.ts does: every write is told.
vfs.watch((_event, path) => compileWhenWritten(path));
const write = (name: string, code: string) => vfs.write(`${DIR}/${name}`, new TextEncoder().encode(code));
const start = (waitMs?: number) => {
  sent.length = 0;
  compileAhead([DIR], { vfs, base: 'http://host.test/__sandburg', compileCache: null, waitMs });
  Atomics.store(new Int32Array(alive!), 0, 1);
};

test('a file written under the directories is sent as written; its output serves the program', async () => {
  start();
  answer = (m) => `compiled:${new TextDecoder().decode(m.bytes)}`;
  write('a.js', 'module.exports = async () => 1;');
  write('plain.js', 'module.exports = 1;'); // nothing to lower: not sent
  await tick();
  assert.deepEqual(
    sent.map((m) => m.path),
    [`${DIR}/a.js`],
  );
  assert.equal(compiledAhead(`${DIR}/a.js`), 'compiled:module.exports = async () => 1;');
  // Used once.
  assert.equal(compiledAhead(`${DIR}/a.js`), null);
});

test('a file changed without being told again is not served its old output (the bytes it was compiled from)', async () => {
  start();
  answer = () => 'old output';
  write('b.js', 'module.exports = async () => "old";');
  await tick();
  // Its bytes replaced without a write the watcher sees (the guard on the file's own bytes alone).
  const file = `${DIR}/b.js`;
  const rewritten = new TextEncoder().encode('module.exports = async () => "new";');
  (vfs as unknown as { files: Map<string, { data: Uint8Array }> }).files.get(file)!.data = rewritten;
  assert.equal(compiledAhead(file), null);
});

test('a file written again just before it is required is compiled again, not served the first output', async () => {
  start();
  answer = (m) => `out:${new TextDecoder().decode(m.bytes)}`;
  write('c.js', 'module.exports = async () => "first";');
  await tick();
  // Written again in the program's task, then required in it: sent again before the wait.
  write('c.js', 'module.exports = async () => "second";');
  assert.equal(compiledAhead(`${DIR}/c.js`), 'out:module.exports = async () => "second";');
  assert.equal(sent.length, 2);
});

test('a file removed is dropped; few files are kept waiting, each with memory sized from it', async (t) => {
  start();
  answer = () => undefined;
  for (let i = 0; i < 40; i++) write(`many-${i}.js`, 'module.exports = async () => 0;');
  await tick();
  assert.equal(sent.length, 40);
  assert.ok(sent.every((m) => m.shared.maxByteLength <= 8 + (1 << 20)));
  const waited = waits(t);
  // The oldest sent are no longer waited for (dropped at once, without waiting).
  assert.equal(compiledAhead(`${DIR}/many-0.js`), null);
  assert.equal(waited.callCount(), 0);
  // A removed file is not waited for (its compile would have nothing to serve).
  write('gone.js', 'module.exports = async () => 0;');
  await tick();
  vfs.unlink(`${DIR}/gone.js`);
  assert.equal(compiledAhead(`${DIR}/gone.js`), null);
  assert.equal(waited.callCount(), 0);
});

test('a helper that does not answer is waited for once: later files are compiled at once', async (t) => {
  start(200);
  answer = () => undefined;
  write('d.js', 'module.exports = async () => 1;');
  write('e.js', 'module.exports = async () => 2;');
  write('f.js', 'module.exports = async () => 3;');
  await tick();
  const waited = waits(t);
  const t0 = performance.now();
  assert.equal(compiledAhead(`${DIR}/d.js`), null);
  assert.ok(performance.now() - t0 >= 150);
  assert.equal(waited.callCount(), 1);
  assert.equal(compiledAhead(`${DIR}/e.js`), null);
  assert.equal(compiledAhead(`${DIR}/f.js`), null);
  assert.equal(waited.callCount(), 1, 'no second wait');
  // Nor is it sent anything more.
  const before = sent.length;
  write('g.js', 'module.exports = async () => 4;');
  await tick();
  assert.equal(sent.length, before);
});
