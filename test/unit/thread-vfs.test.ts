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
