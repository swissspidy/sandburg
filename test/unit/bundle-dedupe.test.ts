import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupedPath } from '../../src/node-runtime/bundle-dedupe.ts';

/** A node_modules tree: package directory (relative) → [version, files, dependencies]. */
function tree(packages: Record<string, [string, Record<string, string>, Record<string, string>?]>): string {
  const root = mkdtempSync(join(tmpdir(), 'sandburg-dedupe-'));
  for (const [dir, [version, files, dependencies]] of Object.entries(packages)) {
    const at = join(root, dir);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name: dir.split('node_modules/').pop(), version, dependencies }));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(at, file, '..'), { recursive: true });
      writeFileSync(join(at, file), text);
    }
  }
  return root;
}

test('a nested copy of a package at the same version resolves to the first copy', () => {
  const root = tree({
    'node_modules/bn.js': ['5.2.5', { 'lib/bn.js': 'v5' }],
    'node_modules/elliptic/node_modules/bn.js': ['4.12.5', { 'lib/bn.js': 'v4' }],
    'node_modules/asn1.js/node_modules/bn.js': ['4.12.5', { 'lib/bn.js': 'v4' }],
    'node_modules/miller-rabin/node_modules/bn.js': ['4.12.5', { 'lib/bn.js': 'v4' }],
  });
  const first = join(root, 'node_modules/asn1.js/node_modules/bn.js/lib/bn.js');
  assert.equal(dedupedPath(join(root, 'node_modules/elliptic/node_modules/bn.js/lib/bn.js')), first);
  assert.equal(dedupedPath(join(root, 'node_modules/miller-rabin/node_modules/bn.js/lib/bn.js')), first);
  assert.equal(dedupedPath(first), first);
  // The top-level copy is another version; a package that is not nested is as it was.
  assert.equal(dedupedPath(join(root, 'node_modules/bn.js/lib/bn.js')), join(root, 'node_modules/bn.js/lib/bn.js'));
});

test('a copy is not shared when its bytes or what its dependencies resolve to differ', () => {
  const root = tree({
    'node_modules/a/node_modules/p': ['1.0.0', { 'index.js': 'one' }],
    'node_modules/b/node_modules/p': ['1.0.0', { 'index.js': 'patched' }],
    'node_modules/c/node_modules/q': ['1.0.0', { 'index.js': 'same' }, { dep: '*' }],
    'node_modules/c/node_modules/dep': ['1.0.0', {}],
    'node_modules/d/node_modules/q': ['1.0.0', { 'index.js': 'same' }, { dep: '*' }],
    'node_modules/dep': ['2.0.0', {}],
  });
  const b = join(root, 'node_modules/b/node_modules/p/index.js');
  assert.equal(dedupedPath(b), b);
  // c's q requires dep 1.0.0, d's requires the top-level 2.0.0.
  const d = join(root, 'node_modules/d/node_modules/q/index.js');
  assert.equal(dedupedPath(d), d);
});
