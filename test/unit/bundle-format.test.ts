import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleHead, bundleHeader } from '../../src/bundle-format.ts';

test('a bundle: its header, then its bodies after the head', () => {
  const bodies = [Buffer.from('one'), Buffer.from([0, 255, 1])];
  const bundle = Buffer.concat([bundleHead([['f', 'a.txt', 3], ['f', 'b.bin', 3]]), ...bodies]);
  assert.equal(bundle.readUInt32LE(0), JSON.stringify([['f', 'a.txt', 3], ['f', 'b.bin', 3]]).length);
  const { header, body } = bundleHeader<[string, string, number]>(bundle);
  assert.deepEqual(header, [['f', 'a.txt', 3], ['f', 'b.bin', 3]]);
  assert.equal(bundle.subarray(body, body + 3).toString(), 'one');
  assert.deepEqual([...bundle.subarray(body + 3)], [0, 255, 1]);
  // A view into a larger buffer (as a runtime's shared memory hands them out) reads the same.
  const larger = new Uint8Array(bundle.length + 16);
  larger.set(bundle, 8);
  assert.deepEqual(bundleHeader(larger.subarray(8, 8 + bundle.length)).header, header);
  // In shared memory too (a runtime's prefetched bundle), which Chromium's TextDecoder does not read
  // (Node's does: test/runtime/files.test.ts's prefetched bundle is the test that tells).
  const shared = new Uint8Array(new SharedArrayBuffer(bundle.length));
  shared.set(bundle);
  assert.deepEqual(bundleHeader(shared).header, header);
});

test('bytes that are not a bundle throw: cut off, a length past the end, a header that is not a list', () => {
  const head = bundleHead([['f', 'a', 1]]);
  assert.throws(() => bundleHeader(new Uint8Array(3)), /cut off/);
  assert.throws(() => bundleHeader(head.subarray(0, head.length - 1)), /cut off/);
  const huge = new Uint8Array(head);
  new DataView(huge.buffer).setUint32(0, 0xffffffff, true);
  assert.throws(() => bundleHeader(huge), /cut off/);
  assert.throws(() => bundleHeader(bundleHead({ not: 'a list' } as unknown as unknown[])), /not a list/);
  const garbage = new Uint8Array([2, 0, 0, 0, 0x7b, 0x7b]);
  assert.throws(() => bundleHeader(garbage), SyntaxError);
});
