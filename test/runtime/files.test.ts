import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_KEY, RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

const install = {
  files: {
    'node_modules/bundled/package.json': JSON.stringify({ name: 'bundled', main: 'index.js' }),
    'node_modules/bundled/index.js': `module.exports = 'from the bundle';`,
    'node_modules/single/package.json': JSON.stringify({ name: 'single', main: 'index.js' }),
    'node_modules/single/index.js': `module.exports = 'asked for on its own';`,
  },
  bundled: ['node_modules/bundled/package.json', 'node_modules/bundled/index.js'],
};

// A program and its thread each load a package the preload bundle has and one it lacks; the
// second is required once the file channel has had time to open.
const program = {
  'main.js': `
    const { Worker } = require('worker_threads');
    console.log('main:', require('bundled'));
    setTimeout(() => {
      console.log('main:', require('single'));
      const w = new Worker('/app/thread.js');
      w.on('message', (m) => console.log('thread:', m));
      w.on('exit', () => process.exit(0));
    }, 300);`,
  'thread.js': `
    const { parentPort } = require('worker_threads');
    parentPort.postMessage(require('bundled') + ', ' + require('single'));`,
};

test('installed files: the preload bundle, shared with threads, and single files over the file channel', async () => {
  const out = await h.runInstalled(program, install, '/app/main.js');
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'main: from the bundle\nmain: asked for on its own\nthread: from the bundle, asked for on its own\n');
  const nm = `/__sandburg/nm/${INSTALL_KEY}`;
  // The thread reads the bundled package in its parent's shared memory, and asks for the rest
  // through its parent's channel; nothing installed is asked for over HTTP but the bundle.
  assert.deepEqual(h.asked.filter((a) => a.includes('/nm/')).sort(), [
    `ws ${nm}/f/node_modules/single/package.json`,
    `ws ${nm}/f/node_modules/single/package.json`,
    `ws ${nm}/t/node_modules/single/index.js`,
    `ws ${nm}/t/node_modules/single/index.js`,
  ]);
  assert.equal(h.asked.filter((a) => a.startsWith('http /__sandburg/preload/')).length, 1);
});

test('installed files: a preload bundle the page downloaded is not requested again', async () => {
  const out = await h.runInstalled(program, install, '/app/main.js', { prefetch: true });
  assert.equal(out.fatal, null);
  assert.equal(out.stdout, 'main: from the bundle\nmain: asked for on its own\nthread: from the bundle, asked for on its own\n');
  // One request for the bundle: the page's.
  assert.deepEqual(h.asked.filter((a) => a.startsWith('http /__sandburg/preload/')).map((a) => a.endsWith('?by=page')), [true]);
  assert.deepEqual(h.asked.filter((a) => a.startsWith('http /__sandburg/nm/')), []);
});
