/** The fidelity corpus (corpus/) is what scripts/corpus/generate.ts makes: regenerated here and compared file for file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApp, type AppMeta } from '../../scripts/corpus/generate.ts';

const corpus = fileURLToPath(new URL('../../corpus', import.meta.url));

test('corpus/ is the generator\'s output, byte for byte, and nothing else', async () => {
  const index = JSON.parse(await readFile(join(corpus, '_corpus.json'), 'utf8')) as { seed: number; count: number; apps: AppMeta[] };
  const expected = new Map<string, string>();
  const metas: AppMeta[] = [];
  for (let i = 0; i < index.count; i++) {
    const { meta, files } = generateApp(i, index.seed);
    metas.push(meta);
    for (const [path, content] of Object.entries(files)) expected.set(`${meta.id}/${path}`, content);
  }
  expected.set('_corpus.json', JSON.stringify({ seed: index.seed, count: index.count, apps: metas }, null, 2) + '\n');

  const onDisk = (await readdir(corpus, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(corpus, join(e.parentPath, e.name)).split(sep).join('/'));
  assert.deepEqual(onDisk.toSorted(), [...expected.keys()].toSorted(), 'the same files');
  for (const path of onDisk) assert.equal(await readFile(join(corpus, path), 'utf8'), expected.get(path), path);
});
