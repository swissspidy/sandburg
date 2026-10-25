import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';
import { ThreadVfs, serveVfsCall, trackNodeModulesWrites } from '../../src/node-runtime/threads.ts';

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
  // Blocked after 1 s here (5 s in the runtime), so that the test does not wait out the runtime's.
  const thread = new ThreadVfs(() => {}, new Vfs(() => new Uint8Array()), '/app', { '/app/src/main.ts': new TextEncoder().encode('') }, undefined, 1000);
  const started = performance.now();
  assert.equal(thread.exists('/app/node_modules/.cache/vite'), false);
  assert.ok(performance.now() - started >= 900);
  assert.equal(thread.exists('/app/.nuxt/nuxt.d.ts'), false); // at once now: the parent is known to be blocked
  assert.ok(performance.now() - started < 2000);
});

// Module resolution in a thread looks for many node_modules paths the install does not have
// (`<package>/node_modules/<name>` for each package up the tree). While nothing but the install has
// written in node_modules, the thread answers those itself; once something has, it asks its parent.
test('a thread tells that a node_modules path is not installed without asking, until node_modules is written', () => {
  const installed = new Vfs(() => new TextEncoder().encode('{}'));
  installed.addRemote('/app/node_modules/@napi-rs/wasm-runtime/package.json', 2);
  const parent = new Vfs(() => new TextEncoder().encode('{}'));
  const flag = trackNodeModulesWrites(parent, '/app', { 'node_modules/@napi-rs/wasm-runtime/package.json': 2 });
  // The main runtime writes a dev server's cache before it registers the install (the cache makes /app/node_modules).
  parent.mkdir('/app/node_modules/.vite/deps', true);
  parent.addRemote('/app/node_modules/@napi-rs/wasm-runtime/package.json', 2);
  parent.mkdir('/app/src', true);
  parent.write('/app/src/main.ts', new Uint8Array());
  const asked: string[] = [];
  const thread = new ThreadVfs(
    (msg) => {
      asked.push(`${msg.op} ${msg.args[0]}`);
      serveVfsCall(parent, msg); // a parent that answers at once
    },
    installed,
    '/app',
    {},
    flag,
  );

  assert.equal(thread.exists('/app/node_modules/@napi-rs/wasm-runtime/node_modules/@emnapi/core'), false);
  assert.equal(thread.kind('/app/node_modules/@emnapi/core/package.json'), null);
  assert.throws(() => thread.stat('/app/node_modules/@emnapi/core'), { code: 'ENOENT' });
  assert.equal(thread.exists('/app/node_modules/@napi-rs/wasm-runtime/package.json'), true);
  // Not node_modules, though the path goes through it; and a cache the parent writes.
  assert.equal(thread.exists('/app/node_modules/../src/main.ts'), true);
  assert.equal(thread.exists('/app/node_modules/.vite/deps/_metadata.json'), false);
  assert.deepEqual(asked, ['exists /app/node_modules/../src/main.ts', 'exists /app/node_modules/.vite/deps/_metadata.json']);
  assert.equal(thread.exists('/app/node_modules'), true);
  assert.equal(Atomics.load(flag, 0), 0);

  // A cache written in node_modules leaves the flag down; a package written there raises it.
  parent.write('/app/node_modules/.vite/deps/_metadata.json', new Uint8Array());
  assert.equal(Atomics.load(flag, 0), 0);
  thread.mkdir('/app/node_modules/@emnapi/core', true);
  assert.equal(Atomics.load(flag, 0), 1);
  asked.length = 0;
  assert.equal(thread.exists('/app/node_modules/@emnapi/core'), true);
  assert.equal(thread.exists('/app/node_modules/@emnapi/runtime'), false);
  assert.deepEqual(asked, ['exists /app/node_modules/@emnapi/core', 'exists /app/node_modules/@emnapi/runtime']);
});

test('an empty node_modules directory the install does not have raises the flag', () => {
  const parent = new Vfs(() => new Uint8Array());
  const flag = trackNodeModulesWrites(parent, '/app', { 'node_modules/a/package.json': 2 });
  parent.mkdir('/app/node_modules/a', true);
  assert.equal(Atomics.load(flag, 0), 0);
  parent.mkdir('/app/src/node_modules', true);
  assert.equal(Atomics.load(flag, 0), 1);
});

// A thread answers reads of the project's files from its snapshot, without asking its parent, while
// nothing the snapshot covers has changed there; its answers are the parent's (stats, listings, bytes,
// errors). Once a covered path changes, it asks again.
test('a thread answers reads of unchanged project files from its snapshot, as its parent would', async () => {
  const { projectSnapshot } = await import('../../src/node-runtime/threads.ts');
  const parent = new Vfs(() => new Uint8Array());
  parent.mkdir('/app/src/lib', true);
  parent.write('/app/package.json', new TextEncoder().encode('{"type":"module"}'));
  parent.write('/app/src/main.ts', new TextEncoder().encode('export {};'));
  parent.write('/app/src/big.bin', new Uint8Array((4 << 20) + 1));
  parent.mkdir('/app/node_modules/.vite/deps', true);
  parent.mkdir('/app/.svelte-kit/generated', true);
  parent.mkdir('/tmp', true);
  const asked: string[] = [];
  const thread = new ThreadVfs(
    (m) => {
      const msg = m as Parameters<typeof serveVfsCall>[1];
      asked.push(`${msg.op} ${msg.args[0]}`);
      serveVfsCall(parent, msg);
    },
    new Vfs(() => new Uint8Array()),
    '/app',
    projectSnapshot(parent, '/app'),
  );
  const outcome = (vfs: Vfs, f: (v: Vfs) => unknown) => {
    try {
      const v = f(vfs);
      return { value: v instanceof Uint8Array ? [...v] : v };
    } catch (e) {
      const err = e as { code?: string; syscall?: string; path?: string; message: string };
      return { error: [err.code, err.syscall, err.path, err.message] };
    }
  };
  const reads: ((v: Vfs) => unknown)[] = [];
  for (const path of ['/', '/app', '/app/', '/app/src', '/app/src/../package.json', '/app/src/main.ts', '/app/src/lib', '/app/nope', '/app/src/main.ts/x', '/app/src/nope/deeper']) {
    reads.push((v) => v.exists(path), (v) => v.stat(path), (v) => v.stat(path, 'lstat'), (v) => v.read(path), (v) => v.readdir(path), (v) => v.kind(path));
  }
  for (const read of reads) assert.deepEqual(outcome(thread, read), outcome(parent, read));
  assert.deepEqual(asked, []);
  // Paths it does not cover: caches, build output, outside the project, a file too big for it.
  assert.equal(thread.exists('/app/node_modules/.vite/deps'), true);
  assert.equal(thread.exists('/app/.svelte-kit/generated'), true);
  assert.equal(thread.exists('/tmp'), true);
  assert.equal(thread.stat('/app/src/big.bin').size, (4 << 20) + 1);
  assert.equal(thread.read('/app/src/big.bin').length, (4 << 20) + 1);
  // (The big read is asked twice: once more with room for its bytes.)
  assert.deepEqual([...new Set(asked)], ['exists /app/node_modules/.vite/deps', 'exists /app/.svelte-kit/generated', 'exists /tmp', 'read /app/src/big.bin']);

  // Writes in caches, build output and outside the project leave it exact.
  parent.write('/app/node_modules/.vite/deps/_metadata.json', new Uint8Array());
  parent.write('/app/.svelte-kit/generated/root.js', new Uint8Array());
  parent.write('/tmp/x', new Uint8Array());
  asked.length = 0;
  assert.equal(thread.exists('/app/src/main.ts'), true);
  assert.deepEqual(asked, []);
  // A new directory in the project's root changes the root's listing.
  parent.mkdir('/app/.astro');
  assert.deepEqual(thread.readdir('/app'), parent.readdir('/app'));
  assert.deepEqual(asked, ['readdir /app']);
});

test('a thread asks its parent again once a file its snapshot covers changes, and its threads get the same snapshot', async () => {
  const { projectSnapshot } = await import('../../src/node-runtime/threads.ts');
  for (const change of [
    (p: Vfs) => p.write('/app/src/main.ts', new TextEncoder().encode('changed')),
    (p: Vfs) => p.writeAt('/app/src/main.ts', new TextEncoder().encode('!'), 'end'),
    (p: Vfs) => p.unlink('/app/src/main.ts'),
    (p: Vfs) => p.rename('/app/src/main.ts', '/app/src/other.ts'),
    (p: Vfs) => p.write('/app/src/new.ts', new Uint8Array()),
    (p: Vfs) => p.mkdir('/app/src/new'),
    (p: Vfs) => p.mkdir('/srv'),
  ]) {
    const parent = new Vfs(() => new Uint8Array());
    parent.mkdir('/app/src', true);
    parent.write('/app/src/main.ts', new TextEncoder().encode('export {};'));
    parent.mkdir('/app/node_modules/.cache', true);
    const first = projectSnapshot(parent, '/app');
    // A write the snapshot does not cover rebuilds the next one, but the first stays exact.
    parent.write('/app/node_modules/.cache/x', new Uint8Array());
    const second = projectSnapshot(parent, '/app');
    assert.notEqual(first, second);
    const asked: string[] = [];
    const thread = (snapshot: ReturnType<typeof projectSnapshot>) =>
      new ThreadVfs(
        (m) => {
          const msg = m as Parameters<typeof serveVfsCall>[1];
          asked.push(`${msg.op} ${msg.args[0]}`);
          serveVfsCall(parent, msg);
        },
        new Vfs(() => new Uint8Array()),
        '/app',
        snapshot,
      );
    const a = thread(first);
    const b = thread(second);
    assert.equal(a.exists('/app/src/main.ts'), true);
    assert.equal(projectSnapshot(a, '/app'), first); // a thread's threads
    assert.deepEqual(asked, []);
    change(parent);
    for (const t of [a, b]) {
      for (const path of ['/app/src/main.ts', '/app/src/other.ts', '/app/src/new.ts', '/app/src/new']) assert.equal(t.exists(path), parent.exists(path));
      assert.deepEqual(t.readdir('/app/src'), parent.readdir('/app/src'));
      assert.deepEqual(t.readdir('/'), parent.readdir('/'));
    }
    assert.ok(asked.length > 0);
  }
});
