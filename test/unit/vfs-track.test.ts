/** Vfs.track (src/node-runtime/vfs.ts): whether a run changed a restored dev-server cache, so dispose need not read it back. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../../src/node-runtime/vfs.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function cached(): Vfs {
  const vfs = new Vfs(() => enc('remote'));
  vfs.mkdir('/app/node_modules/.vite/deps', true);
  vfs.write('/app/node_modules/.vite/deps/_metadata.json', enc('{"hash":"a"}'));
  vfs.write('/app/node_modules/.vite/deps/react.js', enc('export {}'));
  vfs.track(['/app/node_modules/.vite']);
  return vfs;
}

test('nothing tracked: null', () => {
  assert.equal(new Vfs(() => enc('')).trackedChanged(), null);
});

test('writes elsewhere, and the same bytes written again, are no change', () => {
  const vfs = cached();
  vfs.mkdir('/app/node_modules/.vite-temp', true);
  vfs.write('/app/node_modules/.vite-temp/vite.config.ts.timestamp-1.mjs', enc('x'));
  vfs.mkdir('/app/src', true);
  vfs.write('/app/src/main.ts', enc('changed'));
  vfs.write('/app/node_modules/.vite/deps/_metadata.json', enc('{"hash":"a"}'));
  vfs.read('/app/node_modules/.vite/deps/react.js');
  assert.equal(vfs.trackedChanged(), false);
});

test('other bytes, a new file, an append, a removal or a rename are a change', () => {
  const cases: [string, (v: Vfs) => void][] = [
    ['other bytes', (v) => v.write('/app/node_modules/.vite/deps/_metadata.json', enc('{"hash":"b"}'))],
    ['same length, other bytes', (v) => v.write('/app/node_modules/.vite/deps/react.js', enc('export {;'))],
    ['a new file', (v) => v.write('/app/node_modules/.vite/deps/vue.js', enc('export {}'))],
    ['an append', (v) => v.write('/app/node_modules/.vite/deps/react.js', enc('//'), true)],
    ['a write at an offset', (v) => v.writeAt('/app/node_modules/.vite/deps/react.js', enc('E'), 0)],
    ['a removal', (v) => v.unlink('/app/node_modules/.vite/deps/react.js')],
    ['the directory removed', (v) => v.rmdir('/app/node_modules/.vite', true)],
    ['a rename out', (v) => v.rename('/app/node_modules/.vite/deps/react.js', '/app/react.js')],
    ['a rename in', (v) => (v.write('/app/tmp.js', enc('1')), v.rename('/app/tmp.js', '/app/node_modules/.vite/deps/tmp.js'))],
    ['the directory renamed (Vite swaps deps_temp in)', (v) => v.rename('/app/node_modules/.vite/deps', '/app/node_modules/.vite/deps_old')],
    ['a remote file added', (v) => v.addRemote('/app/node_modules/.vite/deps/lazy.js', 3)],
  ];
  for (const [name, change] of cases) {
    const vfs = cached();
    change(vfs);
    assert.equal(vfs.trackedChanged(), true, name);
  }
});

test('a file not read yet (remote) written over counts as a change', () => {
  const vfs = new Vfs(() => enc('export {}'));
  vfs.addRemote('/app/node_modules/.vite/deps/react.js', 9);
  vfs.track(['/app/node_modules/.vite']);
  vfs.write('/app/node_modules/.vite/deps/react.js', enc('export {}'));
  assert.equal(vfs.trackedChanged(), true);
});

test('a file written over and back again is no change; written over and left is', () => {
  const vfs = cached();
  // The Angular CLI writes its .tsbuildinfo twice per start, ending with the bytes it had.
  vfs.write('/app/node_modules/.vite/deps/react.js', enc('export { other }'));
  vfs.write('/app/node_modules/.vite/deps/react.js', enc('export {}'));
  assert.equal(vfs.trackedChanged(), false);
  vfs.writeAt('/app/node_modules/.vite/deps/react.js', enc('E'), 0);
  assert.equal(vfs.trackedChanged(), true);
  vfs.writeAt('/app/node_modules/.vite/deps/react.js', enc('e'), 0);
  assert.equal(vfs.trackedChanged(), false);
  vfs.write('/app/node_modules/.vite/deps/react.js', enc('export { changed }'));
  assert.equal(vfs.trackedChanged(), true);
});

test('a new file is a change even if written twice; a file added and removed is a change', () => {
  const vfs = cached();
  vfs.write('/app/node_modules/.vite/deps/vue.js', enc('a'));
  vfs.write('/app/node_modules/.vite/deps/vue.js', enc('a'));
  assert.equal(vfs.trackedChanged(), true);
  const other = cached();
  other.write('/app/node_modules/.vite/deps/vue.js', enc('a'));
  other.unlink('/app/node_modules/.vite/deps/vue.js');
  assert.equal(other.trackedChanged(), true);
});
