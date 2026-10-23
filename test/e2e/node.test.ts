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

test('each run has its own tab, opened ahead of it: a new origin and empty storage', async () => {
  const dir = fixture('node-express');
  const seen: { origin: string; stored: string | null }[] = [];
  const checks = {
    'storage is the run\'s own': async ({ app }: { app: import('playwright-core').Frame }) => {
      const stored = await app.evaluate(() => {
        const before = localStorage.getItem('sandburg-test');
        localStorage.setItem('sandburg-test', 'set by an earlier run');
        return before;
      });
      seen.push({ origin: new URL(app.url()).origin, stored });
    },
  };
  for (let i = 0; i < 2; i++) {
    const result = await session.run(dir, { checks, outDir });
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  }
  // Without a spare, a run opens its own tab when it starts.
  const own = new Session({ spareTab: false });
  await own.open();
  try {
    const result = await own.run(dir, { checks, outDir });
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  } finally {
    await own.close();
  }
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map((s) => s.origin)).size, 3);
  assert.deepEqual(seen.map((s) => s.stored), [null, null, null]);
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

test('the accessibility scan runs whether or not the page lets it load from its origin', async () => {
  // An image without alt text, served with no policy, and with a policy that blocks every script, in
  // a header or a <meta> element. The scan does not try what the policy refuses (the app's console
  // would show it).
  for (const csp of [null, 'header', 'meta']) {
    const headers = JSON.stringify({ 'content-type': 'text/html', ...(csp === 'header' && { 'content-security-policy': "script-src 'none'" }) });
    const meta = csp === 'meta' ? `<meta http-equiv="Content-Security-Policy" content="script-src &#39;none&#39;">` : '';
    const project = projectFromFiles(
      {
        'package.json': JSON.stringify({ name: 'axe-scan', private: true, scripts: { dev: 'node server.js' } }),
        'server.js': `require('node:http').createServer((q, s) => { s.writeHead(200, ${headers}); s.end('<!doctype html><html lang="en"><title>scan</title>${meta}<main><h1>scan</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>'); }).listen(3000);`,
      },
      { name: 'axe-scan', path: 'axe-scan' },
    );
    const result = await session.run(project, { outDir });
    const axe = result.checks.find((c) => c.id === 'axe');
    assert.equal(axe?.status, 'failed', `${csp}: ${JSON.stringify(axe)}`);
    assert.match(axe?.message ?? '', /image-alt/, String(csp));
    assert.ok(!result.console.some((c) => c.text.includes('axe')), JSON.stringify(result.console));
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  }
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

// TypeScript 7's tsc is native code: in the runtime it runs tsrs (@tsrs/wasm) instead (install-rules.ts).
const typescript7 = (name: string, source: string) =>
  projectFromFiles(
    {
      'package.json': JSON.stringify({
        name,
        private: true,
        type: 'module',
        scripts: { dev: 'tsc --noEmit -p . && node server.js' },
        devDependencies: { typescript: '^7' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext', strict: true, noEmit: true }, include: ['*.ts'] }),
      'greeting.ts': source,
      'server.js': "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('<h1>type-checked</h1>')).listen(3000);\n",
    },
    { name, path: name },
  );

test('TypeScript 7 type-checks a project in the runtime (tsrs)', async () => {
  const result = await session.run(typescript7('typescript-7', 'export const greeting: string = "hello";\n'), {
    outDir,
    checks: { renders: async ({ app, expect }) => expect(app.getByRole('heading', { level: 1 })).toHaveText('type-checked') },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

test('a TypeScript 7 type error stops the dev script (tsrs reports it)', async () => {
  const result = await session.run(typescript7('typescript-7-error', 'export const greeting: number = "hello";\n'), { outDir });
  // tsc exits 2, before the server starts: the app's error, as any dev script that stops early.
  assert.equal(result.status, 'error', JSON.stringify(result.failure, null, 2));
  assert.equal(result.failure?.class, 'app-bug', JSON.stringify(result.failure, null, 2));
  assert.match(result.failure?.message ?? '', /exited with code 2 before it started listening/);
  assert.ok(
    result.console.some((m) => m.text.includes("error TS2322: Type 'string' is not assignable to type 'number'.")),
    JSON.stringify(result.console.map((m) => m.text).slice(-20), null, 2),
  );
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
