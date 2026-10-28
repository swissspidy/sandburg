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

test("the source check (src/source-check.ts) flags each corpus app's seeded syntax error and undeclared import, at its line, and nothing else", async () => {
  const { checkSources } = await import('../../src/source-check.ts');
  const { loadProject } = await import('../../src/project.ts');
  const index = JSON.parse(await readFile(join(corpus, '_corpus.json'), 'utf8')) as { apps: AppMeta[] };
  const flagged: string[] = [];
  const expected: string[] = [];
  for (const meta of index.apps) {
    const project = await loadProject(join(corpus, meta.id));
    for (const f of await checkSources(project.files)) {
      const source = project.files[f.file] as string;
      // The seeded line itself: `const broken = ;` (a syntax error's column is past its `=`), or the import.
      const line = source.split('\n')[f.line - 1].trim();
      flagged.push(`${meta.id} ${f.rule} ${f.rule === 'compile-error' ? line : `${f.message}: ${line}`}`);
    }
    if (meta.fault === 'syntax') expected.push(`${meta.id} compile-error const broken = ;`);
    // v6's nanoid (vite-react, next-app, vite-vanilla), v7's dayjs: neither is declared.
    if (meta.fault === 'undeclared-import') {
      const pkg = /^0[0-9]{2}-(?:vite-react|next-app|vite-vanilla|next-pages)$/.test(meta.id) && Number(meta.id.slice(0, 3)) < 100 ? 'nanoid' : 'dayjs';
      expected.push(`${meta.id} undeclared-import ${pkg}: import ${pkg === 'nanoid' ? "{ nanoid } from 'nanoid'" : "dayjs from 'dayjs'"};`);
    }
  }
  assert.deepEqual(flagged, expected);
});
