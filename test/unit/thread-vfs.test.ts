import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';
import { ThreadVfs } from '../../src/node-runtime/threads.ts';

// A worker thread whose parent runtime is blocked (busy in a synchronous request): after a short wait
// its VFS answers reads from its snapshot of the project, which leaves out node_modules. The installed
// packages, and the node_modules directories that hold them, must still be there (the Angular CLI's
// TypeScript thread reported "Cannot find module '@angular/core'" when /app/node_modules was missing).
test('a thread whose parent is blocked still sees node_modules', () => {
  const installed = new Vfs(() => new TextEncoder().encode('{}'));
  installed.addRemote('/app/node_modules/@angular/core/package.json', 2);
  installed.addRemote('/app/node_modules/tslib/package.json', 2);
  const thread = new ThreadVfs(() => {}, installed, '/app', { '/app/src/main.ts': new TextEncoder().encode('export {};') });

  assert.equal(thread.exists('/app/src/main.ts'), true); // from the snapshot (the parent never answers)
  assert.equal(thread.exists('/app/node_modules'), true);
  assert.equal(thread.kind('/app/node_modules'), 'dir');
  assert.equal(thread.stat('/app/node_modules/@angular').kind, 'dir');
  assert.equal(thread.exists('/app/node_modules/tslib/package.json'), true);
  assert.equal(thread.exists('/app/src/node_modules'), false);
});

// A parent that is slow, not blocked (a loaded machine): it answers after the thread's patience ran
// out. The snapshot does not cover caches, so for them the thread must wait for the parent's answer:
// Vite's optimizer had just created node_modules/.cache/vite/deps_temp_*, and rolldown's thread,
// told by its snapshot that the directory did not exist, failed the build.
test('a thread whose parent is slow waits for it on paths its snapshot does not cover', async () => {
  const parentCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.vfs).then(async ({ Vfs }) => {
      const { serveVfsCall } = await import(workerData.threads);
      const vfs = new Vfs(() => new Uint8Array());
      vfs.mkdir('/app/node_modules/.cache/vite/deps_temp_1', true);
      vfs.write('/app/node_modules/.cache/vite/deps_temp_1/package.json', new TextEncoder().encode('{}'));
      vfs.mkdir('/app/src', true);
      parentPort.on('message', (msg) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); // busy for longer than the thread waits
        serveVfsCall(vfs, msg);
      });
      parentPort.postMessage('ready');
    });`;
  const { Worker } = await import('node:worker_threads');
  const parent = new Worker(parentCode, {
    eval: true,
    workerData: {
      vfs: new URL('../../src/node-runtime/vfs.ts', import.meta.url).href,
      threads: new URL('../../src/node-runtime/threads.ts', import.meta.url).href,
    },
  });
  try {
    await new Promise((resolve) => parent.once('message', resolve));
    const thread = new ThreadVfs((m) => parent.postMessage(m), new Vfs(() => new Uint8Array()), '/app', {
      '/app/src/main.ts': new TextEncoder().encode('export {};'),
    });
    assert.equal(thread.exists('/app/node_modules/.cache/vite/deps_temp_1'), true);
    assert.equal(thread.kind('/app/node_modules/.cache/vite/deps_temp_1/package.json'), 'file');
    // A path the snapshot covers is still answered from it while the parent is slow.
    assert.equal(thread.exists('/app/src/main.ts'), true);
  } finally {
    await parent.terminate();
  }
});

// A parent that never answers is blocked, not slow: after a few seconds even a cache path is answered
// from the snapshot (Tailwind v4's scanner, a WebAssembly thread, runs while its parent waits on it).
test('a thread whose parent is blocked answers from its snapshot after all', () => {
  const thread = new ThreadVfs(() => {}, new Vfs(() => new Uint8Array()), '/app', { '/app/src/main.ts': new TextEncoder().encode('') });
  const started = performance.now();
  assert.equal(thread.exists('/app/node_modules/.cache/vite'), false);
  assert.ok(performance.now() - started >= 4500);
  assert.equal(thread.exists('/app/.nuxt/nuxt.d.ts'), false); // at once now: the parent is known to be blocked
  assert.ok(performance.now() - started < 6000);
});
