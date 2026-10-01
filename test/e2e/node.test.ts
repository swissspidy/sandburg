/**
 * Sandburg's own Node.js runtime (ADR 0006): a real Next.js app (next dev,
 * webpack, SWC wasm) and a plain Express server run in a Web Worker in the
 * browser, and a server-side error is classified as an app bug.
 *
 * Dependencies are installed on the host from the npm registry (cached in
 * .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

test('a Next.js 16 app (App Router, API route) runs on the node runtime', async () => {
  const dir = fixture('next-app-router');
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.runtime.name, 'node');
  assert.equal(result.project.framework, 'next');
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 3);
});

test('an Express server runs on the node runtime', async () => {
  const dir = fixture('node-express');
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

test('a Next.js page that throws on the server is an app bug', async () => {
  const project = await loadProject(fixture('next-app-router'));
  const broken = projectFromFiles(
    {
      ...project.files,
      'app/page.tsx': "export default function Home() {\n  throw new Error('habit store unavailable');\n}\n",
    },
    { name: 'next-app-router-broken', path: fixture('next-app-router') },
  );
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.class, 'app-bug', JSON.stringify(result.failure, null, 2));
});

test('a project without dependencies runs (npm creates no node_modules for it)', async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'no-dependencies', private: true, scripts: { dev: 'node server.js' } }),
      'server.js': "require('node:http').createServer((q, s) => s.end('<h1>no dependencies</h1>')).listen(3000);",
    },
    { name: 'no-dependencies', path: 'no-dependencies' },
  );
  const result = await session.run(project, {
    outDir,
    checks: { renders: async ({ app, expect }) => expect(app.getByRole('heading', { level: 1 })).toHaveText('no dependencies') },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

// A module whose f() traps (unreachable).
const TRAP = `new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([${[0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 5, 1, 3, 0, 0, 11]}]))).exports.f()`;

const crashCases = {
  // A thread the page's request waits on, as rolldown's dependency optimizer waits on its threads.
  'waits for it': [
    "const { Worker } = require('node:worker_threads');",
    "require('node:http').createServer(() => {",
    `  new Worker('setTimeout(() => ${TRAP})', { eval: true }).on('error', () => {});`,
    '}).listen(3000);',
  ],
  // The same, trapping in a promise callback (an unhandled rejection, not an uncaught exception).
  'waits for it (promise callback)': [
    "const { Worker } = require('node:worker_threads');",
    "require('node:http').createServer(() => {",
    `  new Worker('Promise.resolve().then(() => ${TRAP})', { eval: true }).on('error', () => {});`,
    '}).listen(3000);',
  ],
  // The parent blocks in Atomics.wait, so it cannot pass the crash on: the thread reports it itself.
  'is blocked': [
    "const { Worker } = require('node:worker_threads');",
    `const worker = new Worker("require('node:worker_threads').parentPort.on('message', () => setTimeout(() => ${TRAP}))", { eval: true });`,
    "worker.on('error', () => {});",
    "const server = require('node:http').createServer(() => {",
    "  worker.postMessage('go');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '});',
    // A browser cannot start a worker while its parent is blocked: the thread is running first.
    "worker.once('online', () => server.listen(3000));",
  ],
};

for (const [parent, server] of Object.entries(crashCases)) {
  test(`a WebAssembly thread that crashes while its parent ${parent} ends the run at once, as a runtime limitation`, async () => {
    const project = projectFromFiles(
      {
        'package.json': JSON.stringify({ name: 'wasm-thread-crash', private: true, scripts: { dev: 'node server.js' } }),
        'server.js': server.join('\n'),
      },
      { name: 'wasm-thread-crash', path: 'wasm-thread-crash' },
    );
    const started = Date.now();
    const result = await session.run(project, { outDir });
    assert.equal(result.status, 'error', JSON.stringify(result.failure, null, 2));
    assert.equal(result.failure?.phase, 'ready');
    assert.equal(result.failure?.class, 'runtime-unsupported');
    assert.equal(result.failure?.rule, 'signature:wasm-thread-crash');
    assert.match(result.failure?.message ?? '', /a WebAssembly thread crashed \(worker \d+\): RuntimeError: unreachable/);
    assert.ok(Date.now() - started < 30_000, `the run took ${Date.now() - started} ms`);
  });
}
