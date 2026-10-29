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
  const { checkSourcesHere } = await import('../../src/source-check.ts');
  const { loadProject } = await import('../../src/project.ts');
  const { UNDECLARED } = await import('../../scripts/corpus/stacks.ts');
  const index = JSON.parse(await readFile(join(corpus, '_corpus.json'), 'utf8')) as { apps: AppMeta[] };
  const flagged: string[] = [];
  const expected: string[] = [];
  for (const { id } of index.apps) {
    const meta = JSON.parse(await readFile(join(corpus, id, 'meta.json'), 'utf8')) as AppMeta;
    const project = await loadProject(join(corpus, id));
    for (const f of await checkSourcesHere(project.files)) flagged.push(`${id} ${f.rule} ${f.file}:${f.line}${f.rule === 'undeclared-import' ? ` ${f.message}` : ''}`);
    // Where the generator seeded the app's fault: the line it wrote (v6's nanoid, v7's dayjs).
    const seeded = meta.fault === 'syntax' ? /^\s*const broken = ;$/ : meta.fault === 'undeclared-import' ? new RegExp(`^\\s*import .* from '(nanoid|${UNDECLARED})';$`) : null;
    if (!seeded) continue;
    for (const [file, content] of Object.entries(project.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (typeof content !== 'string' || file === 'checks.spec.ts') continue;
      content.split('\n').forEach((line, i) => {
        const m = seeded.exec(line);
        if (m) expected.push(`${id} ${meta.fault === 'syntax' ? 'compile-error' : 'undeclared-import'} ${file}:${i + 1}${m[1] ? ` ${m[1]}` : ''}`);
      });
    }
  }
  assert.equal(expected.length, index.apps.filter((a) => a.fault === 'syntax' || a.fault === 'undeclared-import').length, 'one seeded line per such app');
  assert.deepEqual(flagged, expected);
});
