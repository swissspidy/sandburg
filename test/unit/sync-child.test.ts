/**
 * The channel between a synchronous child process and its blocked parent (node-runtime/sync-child.ts),
 * and the helper's side of starting and ending children (SPAWN_HELPER), in Node: Atomics and shared
 * memory behave as in the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARK_DEAD, SPAWN_HELPER, encodeCall, serveSyncChild, syncChannel, syncParent } from '../../src/node-runtime/sync-child.ts';
import { Vfs } from '../../src/node-runtime/vfs.ts';

const markDead = new Function(`return ${MARK_DEAD}`)() as (sab: SharedArrayBuffer) => void;
const noFiles = () => new Vfs(() => {
  throw new Error('no remote files');
});

test('a child marked dead between the parent\'s check and its wait wakes the parent (no lost wakeup)', () => {
  const sab = syncChannel();
  const wait = Atomics.wait;
  const slept: string[] = [];
  // The helper marks the child dead just as the parent goes to sleep: after it looked, before it waits.
  Atomics.wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    if (!slept.length) markDead(sab);
    const result = wait(array, index, value, Math.min(timeout ?? Infinity, 1000));
    slept.push(result);
    return result;
  }) as typeof Atomics.wait;
  try {
    assert.deepEqual(serveSyncChild(sab, noFiles(), Infinity, () => true), { crashed: true });
  } finally {
    Atomics.wait = wait;
  }
  assert.deepEqual(slept, ['not-equal'], 'the parent slept although the child was dead');
});

/** The helper's side, with workers that record what happens to them. */
function helper() {
  const workers: { url: string; init: unknown; terminated: boolean; onerror: ((e: object) => void) | null; postMessage(init: unknown): void; terminate(): void }[] = [];
  class FakeWorker {
    url: string;
    init: unknown = null;
    terminated = false;
    onerror: ((e: object) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      workers.push(this);
    }
    postMessage(init: unknown) {
      this.init = init;
    }
    terminate() {
      this.terminated = true;
    }
  }
  const message = new Function('Worker', `${SPAWN_HELPER}\nreturn spawnerMessage;`)(FakeWorker) as (data: unknown, from: string | null) => boolean;
  /** A runtime's spawner port, registered by `from`: what it sends arrives as from `owner`. */
  const port = (owner: string, from: string) => {
    const p: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    message({ spawnerPort: p, owner }, from);
    return (data: unknown) => p.onmessage!({ data });
  };
  return { message, port, workers };
}
const dead = (sab: SharedArrayBuffer) => Atomics.load(new Int32Array(sab), 3) === 1;
const RUNTIME = 'http://localhost/__sandburg/node-worker.js';

test("the helper starts only the runtime's script the main runtime named, for the child's own parent", () => {
  const { message, port, workers } = helper();
  // No runtime named yet: refused, and the parent is told (not left waiting).
  const early = syncChannel();
  port('a', 'root');
  message({ spawn: 'a', init: {}, sync: early }, 'root');
  assert.ok(dead(early));
  // A child runtime cannot name another script; the main runtime names it once.
  const fromChild = port('b', 'root');
  fromChild({ runtime: 'http://localhost/evil.js' });
  message({ runtime: RUNTIME }, 'root');
  message({ runtime: 'http://localhost/other.js' }, 'root');
  // Only the runtime that registered a child's port may start it.
  const notParent = syncChannel();
  port('c', 'root');
  fromChild({ spawn: 'c', init: {}, sync: notParent });
  assert.ok(dead(notParent));
  // A spawn without a channel, or with a bad one, is dropped (no one waits on it).
  assert.equal(message({ spawn: 'c', init: {}, sync: 'not memory' }, 'root'), true);
  assert.equal(workers.length, 0);
  const ok = syncChannel();
  message({ spawn: 'c', init: { type: 'init' }, sync: ok }, 'root');
  assert.deepEqual(workers.map((w) => [w.url, w.init]), [[RUNTIME, { type: 'init' }]]);
  assert.ok(!dead(ok));
  // A file channel port's messages (from null) are not the spawner's.
  assert.equal(message({ spawn: 'c' }, null), false);
});

test("a child's worker that fails marks its channel dead, and its parent stops waiting (crashed)", () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  port('a', 'root');
  const sab = syncChannel();
  message({ spawn: 'a', init: {}, sync: sab }, 'root');
  workers[0].onerror!({ preventDefault() {} });
  assert.ok(workers[0].terminated);
  assert.deepEqual(serveSyncChild(sab, noFiles(), Infinity, () => true), { crashed: true });
});

test("ending a child ends the runtimes under it, synchronous grandchildren too, and forgets them", () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  const a = port('a', 'root');
  message({ spawn: 'a', init: {}, sync: syncChannel() }, 'root');
  // a starts b (synchronously), b an asynchronous child c, which starts d synchronously.
  const b = port('b', 'a');
  void b;
  a({ spawn: 'b', init: {}, sync: syncChannel() });
  const c = port('c', 'b');
  port('d', 'c');
  c({ spawn: 'd', init: {}, sync: syncChannel() });
  const sibling = port('e', 'root');
  void sibling;
  message({ spawn: 'e', init: {}, sync: syncChannel() }, 'root');
  // Only a runtime's parent may end it.
  a({ end: 'e' });
  assert.deepEqual(workers.map((w) => w.terminated), [false, false, false, false]);
  message({ end: 'a' }, 'root');
  assert.deepEqual(workers.map((w) => w.terminated), [true, true, true, false]);
  // Forgotten: the tags can be registered again.
  port('a', 'root');
  message({ spawn: 'a', init: {}, sync: syncChannel() }, 'root');
  assert.equal(workers.length, 5);
});

test("the channel's limits: a payload larger than it is an EFBIG error on either side, not a RangeError", () => {
  const sab = syncChannel(1024);
  // The child's side: a write too large for the channel fails the write (the parent is not asked).
  const post = syncParent(sab);
  const answer = new SharedArrayBuffer(16 + 4096);
  post({ type: 'vfs-rpc', sab: answer, op: 'write', args: ['/app/big', new Uint8Array(4096), false] });
  const header = new Int32Array(answer, 0, 4);
  assert.equal(header[0], 2);
  assert.match(new TextDecoder().decode(new Uint8Array(answer, 16, header[1])), /"code":"EFBIG"/);
  // The parent's side: a file too large to send back is an EFBIG answer.
  const vfs = noFiles();
  vfs.mkdir('/app', true);
  vfs.write('/app/big', new Uint8Array(4096));
  const request = encodeCall('read', ['/app/big']);
  const h = new Int32Array(sab, 0, 8);
  new Uint8Array(sab, 32, request.length).set(request);
  h[1] = 1;
  h[2] = request.length;
  Atomics.store(h, 0, 1);
  assert.deepEqual(serveSyncChild(sab, vfs, performance.now() + 50, () => true), { timedOut: true });
  assert.equal(h[4], 2);
  assert.match(new TextDecoder().decode(new Uint8Array(sab, 32, h[6]).slice()), /"code":"EFBIG".*read '\/app\/big'/);
});

test('a channel takes less address space where 1 GiB cannot be reserved', () => {
  const Native = globalThis.SharedArrayBuffer;
  globalThis.SharedArrayBuffer = class extends Native {
    constructor(length: number, options?: { maxByteLength?: number }) {
      if ((options?.maxByteLength ?? 0) > 1 << 27) throw new RangeError('Array buffer allocation failed');
      super(length, options);
    }
  } as SharedArrayBufferConstructor;
  try {
    assert.equal(syncChannel().maxByteLength, 32 + (1 << 26));
  } finally {
    globalThis.SharedArrayBuffer = Native;
  }
});
