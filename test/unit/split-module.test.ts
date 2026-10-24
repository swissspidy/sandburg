import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitModule } from '../../scripts/split-module.ts';

test('split-module moves declarations as they are, with the imports and exports both modules need', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-split-'));
  try {
    const from = join(dir, 'main.ts');
    const to = join(dir, 'part.ts');
    await writeFile(
      from,
      [
        "import { a, b } from './dep.ts';",
        "import type { T } from './types.ts';",
        '',
        'export let state = 0;',
        'const write = (s: string) => s;',
        '',
        '/** Doubles. */',
        'function double(x: T): number {',
        '  // A local of the same name as one that stays: not an import.',
        '  const write = 2;',
        '  return a(x) * write + state;',
        '}',
        '',
        'export function kept(): number {',
        '  return double(1 as T) + b + write("").length;',
        '}',
        '',
        'registry.add = (v: string) => double(v as T);',
        '',
      ].join('\n'),
    );
    splitModule(from, to, ['double', 'stmt:registry.add ='], 'A part.');
    assert.equal(
      await readFile(to, 'utf8'),
      [
        '/**',
        ' * A part.',
        ' */',
        "import { a } from './dep.ts';",
        "import type { T } from './types.ts';",
        "import { state } from './main.ts';",
        '',
        '/** Doubles. */',
        'export function double(x: T): number {',
        '  // A local of the same name as one that stays: not an import.',
        '  const write = 2;',
        '  return a(x) * write + state;',
        '}',
        '',
        'registry.add = (v: string) => double(v as T);',
        '',
      ].join('\n'),
    );
    assert.equal(
      await readFile(from, 'utf8'),
      [
        "import { b } from './dep.ts';",
        "import type { T } from './types.ts';",
        "import { double } from './part.ts';",
        '',
        'export let state = 0;',
        'const write = (s: string) => s;',
        '',
        'export function kept(): number {',
        '  return double(1 as T) + b + write("").length;',
        '}',
        '',
      ].join('\n'),
    );
    assert.throws(() => splitModule(from, to, ['missing']), /not found at the top level/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
