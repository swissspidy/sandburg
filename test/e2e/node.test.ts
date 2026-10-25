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
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import { createHash } from 'node:crypto';
import { node } from '../../src/adapters/node/index.ts';
import { TRANSFORM_VERSION } from '../../src/adapters/node/install.ts';
import { NODE_VERSION } from '../../src/node-runtime/version.ts';
import type { Checks } from '../../src/index.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

/** The stored Next.js seeds (webpack caches; ADR 0016): file → its paths. */
async function nextSeeds(): Promise<Map<string, string[]>> {
  const dir = fileURLToPath(new URL('../../.sandburg/dev-cache', import.meta.url));
  const seeds = new Map<string, string[]>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
    const paths = Object.keys(JSON.parse(await readFile(join(dir, name), 'utf8')) as object);
    if (paths.some((p) => p.startsWith('.next/'))) seeds.set(join(dir, name), paths);
  }
  return seeds;
}

/** The key of a Next.js seed (nextSeedKey in src/adapters/node/index.ts): a digest of public inputs. */
function seedKey(resolved: Record<string, string>, router: 'app' | 'pages'): string {
  const versions = { next: resolved.next, react: resolved.react, 'react-dom': resolved['react-dom'] };
  return createHash('sha256').update(`next-seed\0${router === 'app' ? '' : `${router}\0`}${JSON.stringify(versions)}\0${NODE_VERSION}\0${TRANSFORM_VERSION}`).digest('hex').slice(0, 24);
}

// First: later tests start from the seed it stores.
test('the first Next.js app of each router starts a seed run beside it, which stores all of webpack\'s cache, and the app cannot write it first', async () => {
  for (const file of (await nextSeeds()).keys()) await Promise.all([rm(file), rm(`${file}.bin`, { force: true })]);
  // The versions each app's install resolved, from which its page could compute its seed's key.
  const resolved = new Map<string, Record<string, string>>();
  const hostInstall = node.hostInstall!;
  node.hostInstall = async (project, log, options) => {
    const host = (await hostInstall.call(node, project, log, options)) as { resolved: Record<string, string> };
    if (!options?.seed) resolved.set(project.name, host.resolved);
    return host as never;
  };
  const statuses: number[] = [];
  const own = new Session();
  await own.open();
  try {
    for (const dir of [fixture('next-app-router'), fixture('next-pages-router')]) {
      const project = await loadProject(dir);
      const checks = { ...((await import(`${dir}/checks.spec.ts`)) as { default: Checks }).default };
      if (dir.endsWith('next-pages-router')) {
        // The app runs beside its own seed run, whose key is issued once the seed run installs: its page
        // posts a planted cache under that key until it is taken, or for 15 s.
        checks['posts a cache under the seed key of its versions'] = async ({ app }) => {
          const key = seedKey(resolved.get(project.name)!, 'pages');
          const body = JSON.stringify({ '.next/dev/cache/webpack/client-development/index.pack.gz': 'planted', '.next/dev/cache/webpack/server-development/index.pack.gz': 'planted' });
          for (const end = Date.now() + 15_000; Date.now() < end && !statuses.includes(200); ) {
            statuses.push(await app.evaluate(([k, b]) => fetch(`/__sandburg/dev-cache/${k}`, { method: 'POST', body: b }).then((r) => r.status), [key, body] as const));
            await new Promise((r) => setTimeout(r, 250));
          }
        };
      }
      const result = await own.run(project, { checks, outDir });
      assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
    }
  } finally {
    node.hostInstall = hostInstall;
    // Waits for the seed runs.
    await own.close();
  }
  assert.ok(statuses.length > 0 && statuses.every((s) => s === 403), JSON.stringify(statuses));
  // One for the App Router, one for the Pages Router (webpack's names for modules differ between them).
  const stored = await nextSeeds();
  const seeds = [...stored.values()];
  assert.equal(seeds.length, 2);
  for (const seed of seeds) {
    for (const compiler of ['client', 'server']) assert.ok(seed.includes(`.next/dev/cache/webpack/${compiler}-development/index.pack.gz`), seed.join('\n'));
    // Not while webpack was still writing a pack (under <name>_).
    assert.ok(!seed.some((p) => p.endsWith('_')), seed.join('\n'));
  }
  // The seed run's own write landed, under the key the app knew.
  const pages = [...stored.keys()].find((file) => file.endsWith(`${seedKey(resolved.get('next-pages-router')!, 'pages')}.json`));
  assert.ok(pages, [...stored.keys()].join('\n'));
  assert.ok(!(await readFile(pages, 'utf8')).includes('planted'));
});

test('an app cannot store a seed: the host refuses a cache under a seed\'s key from its run', async () => {
  const seeds = await nextSeeds();
  assert.ok(seeds.size > 0, 'the test before stores the seeds');
  const before = await Promise.all([...seeds.keys()].map((file) => readFile(file, 'utf8')));
  const keys = [...seeds.keys()].map((file) => /([0-9a-f]{24})\.json$/.exec(file)![1]);
  const statuses: number[] = [];
  const dir = fixture('next-pages-router');
  const result = await session.run(dir, {
    outDir,
    checks: {
      // The app's page can reach the host's routes on its origin, and learns a seed's key from its
      // bundle's URL: its run was not issued that key.
      'posts a cache under each seed key': async ({ app }) => {
        for (const key of keys) {
          const body = JSON.stringify({ '.next/dev/cache/webpack/client-development/index.pack.gz': 'planted' });
          statuses.push(await app.evaluate(([k, b]) => fetch(`/__sandburg/dev-cache/${k}`, { method: 'POST', body: b }).then((r) => r.status), [key, body] as const));
        }
      },
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  assert.deepEqual(statuses, keys.map(() => 403));
  assert.deepEqual(await Promise.all([...seeds.keys()].map((file) => readFile(file, 'utf8'))), before);
});

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
      // A page with its type, as dev servers send it: without one, the runtime waits up to 60 s for a
      // port that answers with HTML before it takes the first (pagePort).
      'server.js': "import { createServer } from 'node:http';\ncreateServer((q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end('<h1>type-checked</h1>')).listen(3000);\n",
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
