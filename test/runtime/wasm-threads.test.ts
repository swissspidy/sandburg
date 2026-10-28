/**
 * WebAssembly threads on a shared memory that grows (ADR 0067). The expected output is what the
 * WebAssembly threads specification gives, and what Node 24 gives for a plain store (op 3): an
 * access to memory another thread grew, ordered after the growth through an atomic, is in bounds.
 * Node 24 itself (V8 13.6) traps in ops 0-2 ("RuntimeError: memory access out of bounds"), as
 * Chromium does without the runtime's guard (wasm-grow-guard.ts): V8 tells other threads' instances
 * of the new size only at their next interrupt check, and bulk memory and atomic operations check
 * bounds against the size the instance knows. Rolldown's WebAssembly build trapped there.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

/**
 * A thread grows a shared memory a page at a time (`writer`) and publishes each new page's address;
 * `reader` waits for it and fills it (op 0), copies to it (1), adds to it atomically (2) or stores
 * to it (3). WAT and the same module: test/unit/wasm-grow-guard.test.ts (PING_PONG).
 */
const PING_PONG = 'AGFzbQEAAAABDAJgAX8Bf2ACf38BfwISAQNlbnYGbWVtb3J5AgMBgIAEAwMCAAEHEwIGd3JpdGVyAAAGcmVhZGVyAAEKxQECRwECfwJAA0AgASAATw0BQQFAAEEQdEHAAGohAiACQcAASA0BQQAgAv4XAgAgAUEBaiEBA0BBBP4QAgAgAUkNAAsMAAsLIAELewEDfwJAA0AgAiAATw0BA0BBAP4QAgAhAyADIARGDQALIAMhBCABRQRAIANBB0EQ/AsACyABQQFGBEAgA0EAQQj8CgAACyABQQJGBEAgA0EB/h4CABoLIAFBA0YEQCADQQE2AgALIAJBAWohAkEEIAL+FwIADAALCyACCw==';

test('WebAssembly threads: memory another thread just grew can be filled, copied to and updated atomically', async () => {
  const out = await h.run(
    {
      'main.js': `
        const PING_PONG = '${PING_PONG}';
        const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
        const ROUNDS = 20000;
        const bytes = Buffer.from(PING_PONG, 'base64');
        if (isMainThread) {
          (async () => {
            for (const [op, how] of [[0, 'new Module'], [1, 'compile'], [2, 'instantiate'], [3, 'new Module']]) {
              const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
              const imports = { env: { memory } };
              let module, reader;
              if (how === 'new Module') module = new WebAssembly.Module(bytes);
              else if (how === 'compile') module = await WebAssembly.compile(bytes);
              else ({ module, instance: reader } = await WebAssembly.instantiate(bytes, imports));
              reader ??= new WebAssembly.Instance(module, imports);
              const w = new Worker(__filename, { workerData: { module, memory } });
              const seen = await new Promise((resolve) => w.once('message', resolve));
              let result;
              try {
                result = reader.exports.reader(ROUNDS, op) + ' rounds';
              } catch (e) {
                result = e.name + ': ' + e.message;
              }
              await w.terminate();
              console.log('op ' + op + ' (' + how + '): ' + result + '; in the thread: ' + seen);
            }
          })();
        } else {
          const { module, memory } = workerData;
          const writer = new WebAssembly.Instance(module, { env: { memory } });
          parentPort.postMessage((module instanceof WebAssembly.Module) + ' ' + WebAssembly.Module.exports(module).map((e) => e.name).join(','));
          writer.exports.writer(ROUNDS);
        }`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(
    out.stdout,
    [
      'op 0 (new Module): 20000 rounds; in the thread: true writer,reader',
      'op 1 (compile): 20000 rounds; in the thread: true writer,reader',
      'op 2 (instantiate): 20000 rounds; in the thread: true writer,reader',
      'op 3 (new Module): 20000 rounds; in the thread: true writer,reader',
      '',
    ].join('\n'),
  );
});
