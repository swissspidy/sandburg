/**
 * The http shim against Node 24 (ADR 0069): each program in fixtures/http runs as is under Node, and
 * what it is expected to print here is what Node 24 printed for it (`node test/runtime/fixtures/http/<name>.cjs`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

/** Runs fixtures/http/`main` (with the other programs it starts) in the runtime: the lines it printed. */
async function run(main: string, others: string[] = [], env: Record<string, string> = {}): Promise<string[]> {
  const files = Object.fromEntries([main, ...others].map((name) => [name, readFileSync(new URL(`./fixtures/http/${name}`, import.meta.url), 'utf8')]));
  const out = await h.run(files, `/app/${main}`, [], undefined, { env });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stderr, '');
  return out.stdout.trimEnd().split('\n');
}

// Node's: with its socket, what destroying a request emits comes as the socket closes (after what the
// turn queued, setImmediate's too), 'abort' on the next tick; before it, as it gets its socket.
const DESTROY_ORDER = [
  'sync destroy: pre,post,error socket hang up,close,tick,promise,immediate',
  'sync destroyErr: pre,post,error mine,close,tick,promise,immediate',
  'sync abort: pre,post,close,abort,late-abort,tick,promise,immediate',
  'sync destroy+abort: pre,post,close,abort,late-abort,tick,promise,immediate',
  'sync abort+destroy: pre,post,close,abort,late-abort,tick,promise,immediate',
  'sync destroy+destroy: pre,post,error socket hang up,close,tick,promise,immediate',
  'socket destroy: socket,pre,post,tick,promise,immediate,error socket hang up,close',
  'socket destroyErr: socket,pre,post,error mine,tick,promise,immediate,close',
  'socket abort: socket,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'socket destroy+abort: socket,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'socket abort+destroy: socket,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'socket destroy+destroy: socket,pre,post,tick,promise,immediate,error socket hang up,close',
  'later destroy: socket,finish,pre,post,tick,promise,immediate,error socket hang up,close',
  'later destroyErr: socket,finish,pre,post,error mine,tick,promise,immediate,close',
  'later abort: socket,finish,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'later destroy+abort: socket,finish,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'later abort+destroy: socket,finish,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'later destroy+destroy: socket,finish,pre,post,tick,promise,immediate,error socket hang up,close',
  'response destroy: socket,finish,response,pre,post,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response destroyErr: socket,finish,response,pre,post,error mine,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response abort: socket,finish,response,pre,post,abort,late-abort,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response destroy+abort: socket,finish,response,pre,post,abort,late-abort,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response abort+destroy: socket,finish,response,pre,post,abort,late-abort,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response destroy+destroy: socket,finish,response,pre,post,tick,promise,immediate,res aborted,close,res error aborted,res close',
  'response res.destroy: socket,finish,response,pre,res aborted,post,tick,res close,immediate,close',
  'end destroy: socket,finish,response,res end,close,res close,pre,post,tick,promise,immediate',
  'end destroyErr: socket,finish,response,res end,close,res close,pre,post,tick,promise,immediate',
  'end abort: socket,finish,response,res end,close,res close,pre,post,abort,late-abort,tick,promise,immediate',
  'end destroy+abort: socket,finish,response,res end,close,res close,pre,post,abort,late-abort,tick,promise,immediate',
  'end abort+destroy: socket,finish,response,res end,close,res close,pre,post,abort,late-abort,tick,promise,immediate',
  'end destroy+destroy: socket,finish,response,res end,close,res close,pre,post,tick,promise,immediate',
  'end res.destroy: socket,finish,response,res end,close,res close,pre,post,tick,immediate',
  'midbody destroy: socket,pre,post,tick,promise,immediate,error socket hang up,close',
  'midbody abort: socket,pre,post,abort,late-abort,tick,promise,immediate,error socket hang up,close',
  'midbody destroyErr: socket,pre,post,error mine,tick,promise,immediate,close',
];

test('http: what destroy(), abort() and their combinations emit, and when, before and after a socket, a response or its end, and mid-body', async () => {
  assert.deepEqual(await run('destroy-order.cjs'), DESTROY_ORDER);
});

test('http: the same, with the server in a child process', async () => {
  assert.deepEqual(await run('destroy-order.cjs', ['destroy-order-server.cjs'], { CHILD: '1' }), DESTROY_ORDER);
});

test('timers: what an immediate or a close callback queues runs before the next; close callbacks run last-closed first', async () => {
  assert.deepEqual(await run('loop-phases.cjs'), [
    'immediate 1',
    'tick after immediate 1',
    'promise after immediate 1',
    'immediate 2',
    'close 3',
    'tick after close 3',
    'close 2',
    'tick after close 2',
    'close 1',
    'tick after close 1',
    'immediate from immediate 1',
    'immediate from close',
  ]);
});

test("http: a server's request destroyed (read or not), or its socket or response: when its events come", async () => {
  assert.deepEqual(await run('server-destroy.cjs'), [
    '/ destroy: pre,aborted,post,tick,req close,immediate,res close',
    '/ destroyErr: pre,aborted,post,tick,error mine,req close,immediate,res close',
    '/ socket: pre,post,tick,immediate,aborted,res close,error aborted,req close',
    '/ res: pre,post,tick,immediate,aborted,res close,error aborted,req close',
    '/read destroy: req close,pre,post,tick,immediate',
    '/read destroyErr: req close,pre,post,tick,immediate',
    '/read socket: req close,pre,post,tick,immediate,res close',
    '/read res: req close,pre,post,tick,immediate,res close',
  ]);
});

test('http: which end of a connection in one process hears first that the server closed it, as the loop phase decides', async () => {
  assert.deepEqual(await run('which-side.cjs'), [
    'res now: act,server aborted,server res close,server req close,client error socket hang up,client close',
    'res later: act,client error socket hang up,client close,server aborted,server res close,server req close',
    'socket now: act,server aborted,server res close,server req close,client error socket hang up,client close',
    'socket later: act,client error socket hang up,client close,server aborted,server res close,server req close',
  ]);
});
