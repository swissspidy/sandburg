import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../../scripts/flakes.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/flakes/nested.mjs', import.meta.url));
// Not as a subtest of this file's run (node:test tells its children so in NODE_TEST_CONTEXT).
const { NODE_TEST_CONTEXT: _, ...env } = process.env;
const flakes = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], { env });

test('scripts/flakes.ts counts a failing subtest by its own name, once, and not its parents', async () => {
  const out = await flakes('--runs', '2', fixture).then(
    () => assert.fail('exits 1 when a test failed'),
    (e: { code: number; stdout: string }) => e,
  );
  assert.equal(out.code, 1);
  const counted = out.stdout.split('\n').filter((l) => /^ {2}\d+× /.test(l));
  assert.deepEqual(counted.sort(), [`  2× ${fixture} › outer › inner › fails`, `  2× ${fixture} › top fails`]);
});

test('scripts/flakes.ts refuses a count that is not a whole number', async () => {
  const out = await flakes('--runs', 'x', fixture).then(
    () => assert.fail('exits 2'),
    (e: { code: number; stderr: string }) => e,
  );
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--runs: a whole number/);
});
