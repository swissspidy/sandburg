import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Vfs } from '../../src/node-runtime/vfs.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** A GC once the current job is over (a WeakRef holds its target until then). */
const collect = async () => {
  await new Promise((r) => setTimeout(r, 0));
  gc();
};

test('an installed file is fetched once; a large one again only after its readers let go of it', async () => {
  const fetched: string[] = [];
  const vfs = new Vfs((path) => (fetched.push(path), new Uint8Array(path.endsWith('.wasm') ? 8 << 20 : 100).fill(7)));
  vfs.addRemote('/app/node_modules/a/index.js', 100);
  vfs.addRemote('/app/node_modules/b/b.wasm', 8 << 20);

  vfs.read('/app/node_modules/a/index.js');
  await collect();
  vfs.read('/app/node_modules/a/index.js');
  assert.deepEqual(fetched, ['/app/node_modules/a/index.js'], 'small: kept');

  let held: Uint8Array | null = vfs.read('/app/node_modules/b/b.wasm');
  await collect();
  assert.equal(vfs.read('/app/node_modules/b/b.wasm'), held, 'held by a reader: the same bytes, not fetched again');
  assert.equal(vfs.stat('/app/node_modules/b/b.wasm').size, 8 << 20);
  held = null;
  await collect();
  const again = vfs.read('/app/node_modules/b/b.wasm');
  assert.equal(again.length, 8 << 20);
  assert.equal(again[0], 7);
  assert.deepEqual(fetched.filter((p) => p.endsWith('.wasm')).length, 2, 'let go of: fetched again');
  assert.equal(vfs.stat('/app/node_modules/b/b.wasm').size, 8 << 20);

  // Written over, it is the program's own file, kept as written.
  vfs.write('/app/node_modules/b/b.wasm', new Uint8Array(5 << 20));
  await collect();
  assert.equal(vfs.read('/app/node_modules/b/b.wasm').length, 5 << 20);
  assert.equal(fetched.length, 3);
});

test('a large installed file written over with the bytes it had is no change to a tracked directory', () => {
  const vfs = new Vfs(() => new Uint8Array(8 << 20).fill(7));
  vfs.addRemote('/app/node_modules/.cache/x/big.bin', 8 << 20);
  vfs.track(['/app/node_modules/.cache/x']);
  const held = vfs.read('/app/node_modules/.cache/x/big.bin');
  vfs.write('/app/node_modules/.cache/x/big.bin', new Uint8Array(held));
  assert.equal(vfs.trackedChanged(), false);
  vfs.write('/app/node_modules/.cache/x/big.bin', new Uint8Array(4));
  assert.equal(vfs.trackedChanged(), true);
});
