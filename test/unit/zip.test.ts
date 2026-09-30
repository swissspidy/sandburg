import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, stripCommonRoot } from '../../src/zip.ts';
import { loadProject } from '../../src/project.ts';

/** Builds a zip in memory (stored or deflated entries), as zip tools write them. */
function makeZip(files: Record<string, string | Buffer>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('reads stored and deflated entries', () => {
  for (const deflate of [true, false]) {
    const entries = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.bin': Buffer.from([0, 1, 2, 255]) }, deflate));
    assert.deepEqual(entries.map((e) => [e.path, e.data.toString('hex')]), [['a.txt', Buffer.from('hello').toString('hex')], ['dir/b.bin', '000102ff']]);
  }
});

test('strips a single top-level folder (GitHub-style zips)', () => {
  const entries = stripCommonRoot(readZip(makeZip({ 'app-main/package.json': '{}', 'app-main/src/x.ts': '' })));
  assert.deepEqual(entries.map((e) => e.path), ['package.json', 'src/x.ts']);
  const flat = stripCommonRoot(readZip(makeZip({ 'package.json': '{}', 'src/x.ts': '' })));
  assert.deepEqual(flat.map((e) => e.path), ['package.json', 'src/x.ts']);
});

test('rejects non-zips and bombs', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
  const bomb = makeZip({ 'big.txt': Buffer.alloc(300 * 1024 * 1024) });
  assert.throws(() => readZip(bomb), /256 MB/);
});

test('a zip is a project: junk skipped, traversal rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-zip-'));
  try {
    const good = join(dir, 'app.zip');
    await writeFile(
      good,
      makeZip({
        'app/package.json': JSON.stringify({ name: 'zipped', devDependencies: { vite: '^6' } }),
        'app/index.html': '<div id="root"></div>',
        'app/node_modules/react/index.js': 'x',
        'app/checks.spec.ts': 'export default {}',
        '__MACOSX/app/._index.html': 'junk',
      }),
    );
    // Like real macOS zips: a __MACOSX/ sibling must not stop the app/ root from being stripped.
    const project = await loadProject(good);
    assert.equal(project.name, 'zipped');
    assert.equal(project.framework, 'vite');
    assert.deepEqual(Object.keys(project.files).sort(), ['index.html', 'package.json']);

    const evil = join(dir, 'evil.zip');
    await writeFile(evil, makeZip({ '../outside.txt': 'x' }));
    await assert.rejects(loadProject(evil), /escapes project root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
