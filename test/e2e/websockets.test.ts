/**
 * WebSockets from app pages to servers in the node runtime (ADR 0006):
 * Next.js hot reloading over its HMR socket, and socket.io through Vite's
 * `ws: true` proxy or a direct http://localhost:<port> URL.
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

test('Next.js hot reloading: an edited page updates in place over the HMR WebSocket', async () => {
  const dir = fixture('next-app-router');
  const result = await session.run(dir, { runtime: 'node', checks: `${dir}/hmr.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
  assert.ok(!result.console.some((c) => /WebSocket/i.test(c.text) && c.type === 'error'), 'no WebSocket errors');
});

test('socket.io through Vite\'s ws proxy upgrades to a WebSocket and round-trips messages', async () => {
  const dir = fixture('vite-socketio-chat');
  const result = await session.run(dir, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
});

test('socket.io to http://localhost:3001 directly (no proxy)', async () => {
  const dir = fixture('vite-socketio-chat');
  const base = await loadProject(dir);
  const project = projectFromFiles(
    {
      ...base.files,
      'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
      'src/main.ts': (base.files['src/main.ts'] as string).replace('io()', "io('http://localhost:3001')"),
      'server/index.js': (base.files['server/index.js'] as string).replace('new Server(server)', "new Server(server, { cors: { origin: '*' } })"),
    },
    { name: 'socketio-direct', path: dir },
  );
  const result = await session.run(project, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
});
