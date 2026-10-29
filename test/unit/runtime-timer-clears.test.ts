/**
 * The runtime's own browser timers (nativeSetTimeout) are cleared with the browser's clearTimeout, never
 * the program's: the global clearTimeout is the program's (src/node-runtime/builtins/process.ts), and a
 * browser timer's id given to it is no timer of its (ADR 0069).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src/node-runtime/', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

test("the runtime's code clears no timer with the global clearTimeout or clearInterval (the program's)", () => {
  const bare = /(?<![.\w])(clearTimeout|clearInterval)\(/;
  const found = files(root).flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), at: `${f.slice(root.length)}:${i + 1}` }))
      .filter(({ line }) => bare.test(line) && !line.startsWith('*') && !line.startsWith('//'))
      .map(({ at, line }) => `${at}: ${line}`),
  );
  assert.deepEqual(found, [], "clear the runtime's own timers with the browser's (nativeClearTimeout), the program's with timers.clearTimeout");
});
