/**
 * Full-stack apps (ADR 0009, 0014): the dev script's Vite front end and Express
 * backend, both in the node runtime, in one sandbox, with SQLite over
 * WebAssembly. Covers Vue single-file components, Vite's /api proxy, direct
 * http://localhost:<port> calls, separate client/ and server/ packages,
 * better-sqlite3 and node:sqlite, and how failures are classified.
 *
 * Dependencies are installed on the host from the npm registry (cached in
 * .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
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

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

test('Vue + Vite + Express + better-sqlite3 (concurrently, /api proxy) runs and passes its checks', async () => {
  const dir = fixture('vue-express-sqlite');
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 4);
  assert.ok(result.console.some((c) => c.text.includes('[server] API listening on http://localhost:3001')));
});

test('sandburg run --save-files writes the database the checks left behind into the project, and only what matches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'sandburg-save-'));
  const dir = join(tmp, 'app');
  try {
    await cp(fixture('vue-express-sqlite'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    // The fixture's checks, then one that has the page return more than was asked for: the host
    // writes only the files whose path matches, under the project, outside .git.
    const checks = join(tmp, 'checks.mjs');
    await writeFile(
      checks,
      `import checks from ${JSON.stringify(join(dir, 'checks.spec.ts'))};
      export default {
        ...checks,
        'the page returns extra files': async ({ app }) => {
          await app.evaluate(() => {
            const read = parent.__sandburgReadFiles;
            parent.__sandburgReadFiles = async (match) => ({
              ...(await read(match)),
              'server/db.js': 'replaced',
              'extra.txt': 'extra',
              '../outside.db': 'outside',
              '.git/config.db': 'git',
            });
          });
        },
      };`,
    );
    const serverDb = await readFile(join(dir, 'server/db.js'), 'utf8');
    const code = await main(['run', dir, '--checks', checks, '--out', outDir, '--save-files', String.raw`\.db$`]);
    assert.equal(code, 0);
    const db = await readFile(join(dir, 'notes.db'));
    assert.equal(db.subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal(await readFile(join(dir, 'server/db.js'), 'utf8'), serverDb);
    assert.ok(!existsSync(join(dir, 'extra.txt')));
    assert.ok(!existsSync(join(tmp, 'outside.db')));
    assert.ok(!existsSync(join(dir, '.git')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('client/ + server/ packages: React calls http://localhost:4000 directly; tsx server with node:sqlite', async () => {
  const dir = fixture('react-express-split');
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 3);
});

test('a backend that crashes at startup is an app bug', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const db = (base.files['server/db.js'] as string).replace('CREATE TABLE IF NOT EXISTS notes', 'CREATE TABLE IF NOT EXISTS notes notes');
  const broken = projectFromFiles({ ...base.files, 'server/db.js': db }, { name: 'backend-crash', path: dir });
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.equal(result.failure?.phase, 'start');
  assert.match(result.failure.message, /SqliteError: near "notes": syntax error/);
});

test('a Vue template error fails the build as an app bug, with its location', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const app = (base.files['src/App.vue'] as string).replace('<p role="status">', '<p role="status"');
  const broken = projectFromFiles({ ...base.files, 'src/App.vue': app }, { name: 'vue-template-error', path: dir });
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure.message, /src\/App\.vue:\d+:\d+/);
});

test('an ESM backend with top-level await (setup before listen) runs', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const server = (base.files['server/index.js'] as string).replace(
    "const port = process.env.PORT || 3001;",
    "await new Promise((resolve) => setTimeout(resolve, 20)); // e.g. waiting for migrations\nconst port = process.env.PORT || 3001;",
  );
  const project = projectFromFiles({ ...base.files, 'server/index.js': server }, { name: 'backend-tla', path: dir });
  const result = await session.run(project, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
});

test('a compound dev script whose server sends HTML without a Content-Type is found at once, not after 60 s', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'no-content-type', private: true, scripts: { dev: 'node prep.js && node server.js' } }),
    'prep.js': "console.log('prepared');",
    'server.js': "require('http').createServer((req, res) => { res.end('<!doctype html><html><body><div id=\"app\"><h1>Hello</h1></div></body></html>'); }).listen(3000);",
  };
  const result = await session.run(projectFromFiles(files, { name: 'no-content-type', path: fixture('node-express') }), {
    outDir,
    checks: { 'the page renders': async ({ app, expect }) => void (await expect(app.getByRole('heading', { name: 'Hello' })).toBeVisible()) },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
  assert.ok(result.timings.startMs! < 10_000, `start took ${result.timings.startMs} ms`);
});

test('a compound dev script whose server sends a page no browser would take for a document, without a Content-Type, is taken once it is up, not after 60 s', async () => {
  // A fragment (`<h1>`, which browsers sniff as HTML but pagePort does not take for a document) and plain text.
  for (const [name, body] of [
    ['fragment', '<h1>Hello</h1>'],
    ['text', 'Hello'],
  ]) {
    const files = {
      'package.json': JSON.stringify({ name: `no-content-type-${name}`, private: true, scripts: { dev: 'node prep.js && node server.js' } }),
      'prep.js': "console.log('prepared');",
      'server.js': `require('http').createServer((req, res) => { res.end(${JSON.stringify(body)}); }).listen(3000);`,
    };
    const result = await session.run(projectFromFiles(files, { name: `no-content-type-${name}`, path: fixture('node-express') }), {
      outDir,
      checks: { 'the page shows': async ({ app, expect }) => void (await expect(app.getByText('Hello')).toBeVisible()) },
    });
    assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
    assert.ok(result.timings.startMs! < 10_000, `${name}: start took ${result.timings.startMs} ms`);
  }
});

test('a dev script whose API answers first, with its page server still to start after a pause, gets the page', async () => {
  // While the shell sleeps the API is the only port, and answers no HTML: it is not the app.
  const files = {
    'package.json': JSON.stringify({ name: 'api-then-page', private: true, scripts: { dev: 'node api.js & sleep 3 && node page.js' } }),
    'api.js': "require('http').createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{\"ok\":true}'); }).listen(3001);",
    'page.js': "require('http').createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>The page</h1>'); }).listen(3000);",
  };
  const result = await session.run(projectFromFiles(files, { name: 'api-then-page', path: fixture('node-express') }), {
    outDir,
    checks: { 'the page renders': async ({ app, expect }) => void (await expect(app.getByRole('heading', { name: 'The page' })).toBeVisible()) },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
});

test('a dev script program that forks an API and then starts its own page server gets the page', async () => {
  // dev.js has a child that listens at once (the API); its own server, the page's, comes 3 s later.
  const files = {
    'package.json': JSON.stringify({ name: 'fork-then-page', private: true, scripts: { dev: 'node prep.js && node dev.js' } }),
    'prep.js': "console.log('prepared');",
    'api.js': "require('http').createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{\"ok\":true}'); }).listen(3001);",
    'dev.js':
      "require('child_process').fork('api.js');\n" +
      "setTimeout(() => require('http').createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>The page</h1>'); }).listen(3000), 3000);",
  };
  const result = await session.run(projectFromFiles(files, { name: 'fork-then-page', path: fixture('node-express') }), {
    outDir,
    checks: { 'the page renders': async ({ app, expect }) => void (await expect(app.getByRole('heading', { name: 'The page' })).toBeVisible()) },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
});

test('a dev script program that serves its API and then, seconds later, its page gets the page', async () => {
  // One process: the API (JSON) at once, the page's server 3 s later (as Vite's createServer takes).
  const files = {
    'package.json': JSON.stringify({ name: 'api-then-page-one-process', private: true, scripts: { dev: 'node prep.js && node server.js' } }),
    'prep.js': "console.log('prepared');",
    'server.js':
      "const http = require('http');\n" +
      "http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{\"ok\":true}'); }).listen(3001);\n" +
      "setTimeout(() => http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>The page</h1>'); }).listen(3000), 3000);",
  };
  const result = await session.run(projectFromFiles(files, { name: 'api-then-page-one-process', path: fixture('node-express') }), {
    outDir,
    checks: { 'the page renders': async ({ app, expect }) => void (await expect(app.getByRole('heading', { name: 'The page' })).toBeVisible()) },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
});
