/**
 * Full-stack apps (ADR 0009): a Vite front end built with esbuild-wasm and an
 * Express backend in the node runtime, in one sandbox, with SQLite over
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
  const result = await session.run(dir, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 4);
  assert.ok(result.console.some((c) => c.text.includes('[backend] API listening on http://localhost:3001')));
});

test('client/ + server/ packages: React calls http://localhost:4000 directly; tsx server with node:sqlite', async () => {
  const dir = fixture('react-express-split');
  const result = await session.run(dir, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 3);
});

test('a backend that crashes at startup is an app bug', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const db = (base.files['server/db.js'] as string).replace('CREATE TABLE IF NOT EXISTS notes', 'CREATE TABLE IF NOT EXISTS notes notes');
  const broken = projectFromFiles({ ...base.files, 'server/db.js': db }, { name: 'backend-crash', path: dir });
  const result = await session.run(broken, { runtime: 'esbuild', outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.equal(result.failure?.phase, 'start');
  assert.match(result.failure!.message, /SqliteError: near "notes": syntax error/);
});

test('a Vue template error fails the build as an app bug, with its location', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const app = (base.files['src/App.vue'] as string).replace('<p role="status">', '<p role="status"');
  const broken = projectFromFiles({ ...base.files, 'src/App.vue': app }, { name: 'vue-template-error', path: dir });
  const result = await session.run(broken, { runtime: 'esbuild', outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure!.message, /src\/App\.vue:\d+:\d+/);
});

test('an ESM backend with top-level await (setup before listen) runs', async () => {
  const dir = fixture('vue-express-sqlite');
  const base = await loadProject(dir);
  const server = (base.files['server/index.js'] as string).replace(
    "const port = process.env.PORT || 3001;",
    "await new Promise((resolve) => setTimeout(resolve, 20)); // e.g. waiting for migrations\nconst port = process.env.PORT || 3001;",
  );
  const project = projectFromFiles({ ...base.files, 'server/index.js': server }, { name: 'backend-tla', path: dir });
  const result = await session.run(project, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
});
