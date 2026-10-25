/**
 * esbuild's transforms on the host (ADR NNNN), from inside the runtime: a program's esbuild shim
 * finds the runtime's hook, which asks over the file channel once it is open (from a thread too,
 * through its parent's), over HTTP before, and answers null for what it does not send.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

const ask = (input: string) => `globalThis[Symbol.for('sandburg.esbuildTransform')]('0.25.12', ${JSON.stringify(input)}, { loader: 'ts' })`;

test("a program's transforms go to the host: over HTTP at first, then over the file channel, from threads too", async () => {
  const out = await h.runInstalled(
    {
      'main.js': `
        const { Worker } = require('worker_threads');
        const hook = globalThis[Symbol.for('sandburg.esbuildTransform')];
        // Not sent: an option the host does not take, and an esbuild older than it answers for.
        console.log('ineligible:', hook('0.25.12', 'x', { mangleProps: /_/ }), hook('0.24.2', 'x', {}));
        ${ask('let early: number = 1')}.then((r) => console.log('early:', r.code.trim()));
        setTimeout(async () => {
          console.log('later:', (await ${ask('let later: number = 2')}).code.trim());
          // Code with errors: no answer, for the app's own esbuild to report.
          console.log('errors:', await ${ask('let = ;')});
          const w = new Worker('/app/thread.js');
          w.on('message', (m) => console.log('thread:', m));
          w.on('exit', () => process.exit(0));
        }, 300);`,
      'thread.js': `
        const { parentPort } = require('worker_threads');
        ${ask('let inThread: number = 3')}.then((r) => parentPort.postMessage(r.code.trim()));`,
    },
    { files: {}, bundled: [] },
    '/app/main.js',
  );
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'ineligible: null null\nearly: let early = 1;\nlater: let later = 2;\nerrors: null\nthread: let inThread = 3;\n');
  const path = `/__sandburg/esbuild-transform?v=0.25.12`;
  assert.deepEqual(h.asked.filter((a) => a.includes('esbuild-transform')), [`http ${path}`, `ws /__sandburg/esbuild-transform?v=0.25.12`, `ws /__sandburg/esbuild-transform?v=0.25.12`, `ws /__sandburg/esbuild-transform?v=0.25.12`]);
});
