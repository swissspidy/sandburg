import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { contextAwaits } from '../../src/node-runtime/await-context.ts';
import { contextAwaitsSoon } from '../../src/adapters/node/await-threads.ts';
import { programs } from './await-fuzz.ts';

/** esbuild's output as the host compiles code for the runtime: async functions stay native. */
const compiled = (code: string) =>
  esbuild.transformSync(code, { loader: 'js', target: 'es2022', supported: { 'async-generator': false, 'for-await': false, 'dynamic-import': false }, logLevel: 'silent' }).code;

/** `n` random async programs that esbuild compiles (await-fuzz.ts), in esbuild's output. */
function random(seed: number, n: number): string[] {
  const next = programs(seed);
  const out: string[] = [];
  while (out.length < n) {
    try {
      out.push(compiled(next()));
    } catch {
      // not a valid program
    }
  }
  return out;
}

/** Code over the size the helpers take (smaller code is rewritten on the calling thread). */
const large = (code: string) => `${code}\n${'void 0;\n'.repeat(1024)}`;

test('contextAwaitsSoon answers what contextAwaits does, on a helper thread', async () => {
  const codes = [
    ...random(7, 40).map(large),
    // Not rewritten: lowered instead (a catch parameter with a pattern), and code that does not parse.
    large('async function f() { try { await g(); } catch ({ message }) { return message; } }'),
    large('async function f() { await g(; }'),
    // Small, or without awaits: on this thread.
    'async function f() { return await g(); }',
    large('function f() { return 1; }'),
  ];
  const before = Worker.prototype.postMessage;
  let posted = 0;
  Worker.prototype.postMessage = function (this: Worker, ...a: Parameters<Worker['postMessage']>) {
    posted++;
    return before.apply(this, a);
  };
  try {
    const outs = await Promise.all(codes.map((c) => contextAwaitsSoon(c)));
    assert.deepEqual(outs, codes.map((c) => contextAwaits(c)));
    assert.ok(outs.some((o) => o === null));
    assert.ok(outs.some((o, i) => o !== null && o !== codes[i]));
    // Every file with an await, but the small one.
    assert.equal(posted, codes.filter((c) => c.includes('await')).length - 1);
  } finally {
    Worker.prototype.postMessage = before;
  }
});

test('a helper that fails: its files and later ones are rewritten on this thread, with the same result', async () => {
  const codes = random(11, 10).map(large);
  const before = Worker.prototype.postMessage;
  let killed = false;
  Worker.prototype.postMessage = function (this: Worker, ...a: Parameters<Worker['postMessage']>) {
    before.apply(this, a);
    // The helper ends with files posted to it and not answered.
    if (!killed) {
      killed = true;
      void this.terminate();
    }
  };
  try {
    assert.deepEqual(await Promise.all(codes.map((c) => contextAwaitsSoon(c))), codes.map((c) => contextAwaits(c)));
    assert.ok(killed);
    assert.deepEqual(await contextAwaitsSoon(codes[0]), contextAwaits(codes[0]));
  } finally {
    Worker.prototype.postMessage = before;
  }
});

test('helpers do not hold the process open, idle or after their files', () => {
  // A script file: a process evaluating -e exits with them either way.
  const dir = mkdtempSync(join(tmpdir(), 'sandburg-await-threads-'));
  const script = join(dir, 'run.mjs');
  writeFileSync(
    script,
    `import { contextAwaitsSoon, warmAwaitThreads } from ${JSON.stringify(new URL('../../src/adapters/node/await-threads.ts', import.meta.url).href)};
    warmAwaitThreads();
    const code = 'async function f() { return await g(); }\\n' + 'void 0;\\n'.repeat(1024);
    if (process.argv[2] === 'used') for (let i = 0; i < 3; i++) await contextAwaitsSoon(code);`,
  );
  try {
    for (const mode of ['idle', 'used']) {
      const r = spawnSync(process.execPath, [script, mode], { timeout: 20_000 });
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
