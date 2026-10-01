/**
 * Milestone 2: parallel tabs, shared cache, isolation between sandboxes, and
 * proof that nothing leaves the browser except through the egress gateway.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Session, launchOptions } from '../../src/orchestrator/session.ts';
import { HostServer } from '../../src/orchestrator/host-server.ts';
import { getAdapter } from '../../src/adapters.ts';
import { runBatch, type BatchItem } from '../../src/orchestrator/batch.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import { sharedInstaller } from '../../src/adapters/node/install.ts';
import { extraDependencies } from '../../src/adapters/node/install-rules.ts';
import type { Project } from '../../src/types.ts';

const fixtureDir = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
const batchDir = fileURLToPath(new URL('../../.sandburg/test-batches', import.meta.url));
let counter: Project;

before(async () => {
  counter = await loadProject(fixtureDir);
});

function variant(name: string, files: Record<string, string>): Project {
  return projectFromFiles({ ...counter.files, ...files }, { name, path: `${fixtureDir}#${name}` });
}

test('a batch of 10 projects runs 8 tabs at a time, isolated from each other', async () => {
  const session = new Session();
  await session.open();
  try {
    const items: BatchItem[] = Array.from({ length: 10 }, (_, i) => {
      const label = `app-${i}`;
      // Each app reports what an earlier sandbox may have left in its storage, then leaves its own mark.
      const main = (counter.files['src/main.tsx'] as string).replace(
        "import './index.css';",
        `import './index.css';\ndocument.body.dataset.seen = localStorage.getItem('owner') ?? 'none';\nlocalStorage.setItem('owner', '${label}');`,
      );
      const app = (counter.files['src/App.tsx'] as string).replace('Counter and todos', `Counter ${i}`);
      return {
        label,
        project: variant(label, { 'src/main.tsx': main, 'src/App.tsx': app }),
        checks: {
          'renders its own heading': async ({ app, expect }) => {
            await expect(app.getByRole('heading', { level: 1 })).toHaveText(`Counter ${i}`);
          },
          'sees no storage from other sandboxes': async ({ app, expect }) => {
            await expect(app.locator('body')).toHaveAttribute('data-seen', 'none');
          },
        },
      };
    });
    // The installs the host starts (each runs npm unless the install is on disk already). The session
    // also warms other stacks' installs; the batch's projects share one (the same dependencies).
    const installer = sharedInstaller() as unknown as {
      doInstall: (key: string, ...rest: unknown[]) => Promise<unknown>;
      plan: (project: Project, extra: Record<string, string>) => { key: string };
    };
    const doInstall = installer.doInstall;
    const started: string[] = [];
    installer.doInstall = (key, ...rest) => (started.push(key), doInstall.call(installer, key, ...rest));
    const { summary, results } = await runBatch(session, items, { parallel: 8, outDir, batchDir });
    assert.equal(summary.totals.passed, 10, JSON.stringify(results.filter((r) => r.status !== 'passed').map((r) => [r.failure, r.checks.filter((c) => c.status !== 'passed')]), null, 2));
    assert.equal(summary.runs.length, 10);
    assert.equal(new Set(summary.runs.map((r) => r.snapshotId)).size, 10);
    // One install on the host serves all ten (they share their dependencies): the runs that start
    // after it finished take it from the cache. How long the install itself takes depends on npm's
    // cache, so its time is not checked.
    const batchKey = installer.plan(items[0].project as Project, extraDependencies(items[0].project as Project)).key;
    assert.equal(started.filter((k) => k === batchKey).length, 1, 'installs of the batch started on the host');
    const installMs = results.map((r) => r.timings.installMs ?? Infinity).sort((a, b) => a - b);
    assert.ok(installMs[1] < 5000, `the two runs after the first eight installed in ${installMs.slice(0, 2).join(', ')} ms`);
    assert.ok(summary.speedup > 1.5, `speed-up ${summary.speedup}`);
  } finally {
    delete (sharedInstaller() as unknown as { doInstall?: unknown }).doInstall;
    await session.close();
  }
});

/** A loopback TCP server that counts connections; the app must never reach it. */
async function canary(): Promise<{ server: Server; port: number; connections: () => number }> {
  let count = 0;
  const server = createServer((socket) => {
    count++;
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, connections: () => count };
}

/** Every way an app can open a connection, aimed at `target`. */
function escapeAttempts(port: number): string {
  const targets = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, 'https://example.com'];
  return `
const targets = ${JSON.stringify(targets)};
for (const t of targets) {
  fetch(t + '/fetch').catch(() => {});
  navigator.sendBeacon(t + '/beacon', 'x');
  new Image().src = t + '/img.png';
  const s = document.createElement('script'); s.src = t + '/script.js'; document.head.append(s);
  const f = document.createElement('iframe'); f.src = t + '/frame'; document.body.append(f);
  try { new EventSource(t + '/events'); } catch {}
  try { new WebSocket(t.replace(/^http/, 'ws') + '/ws'); } catch {}
}
document.body.dataset.attempted = 'yes';
`;
}

test('no connection escapes the browser through the egress gateway', async () => {
  const { server, port, connections } = await canary();
  const session = new Session();
  await session.open();
  try {
    const project = variant('escape', {
      'src/main.tsx': (counter.files['src/main.tsx'] as string) + escapeAttempts(port),
    });
    const result = await session.run(project, {
      outDir,
      checks: {
        'attempts ran': async ({ app, expect }) => {
          await expect(app.locator('body')).toHaveAttribute('data-attempted', 'yes');
          await app.waitForTimeout(1500); // let retries and reconnects happen
        },
      },
    });
    assert.equal(result.checks.find((c) => c.kind === 'functional')?.status, 'passed', JSON.stringify(result.failure));
    assert.equal(connections(), 0, 'the canary server was reached');
    const blocked = result.network.blocked.map((b) => `${b.method} ${new URL(b.url).host}`);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'example.com']) {
      assert.ok(blocked.some((b) => b.endsWith(host)), `${host} not recorded as blocked: ${blocked.join(', ')}`);
    }
    assert.ok(blocked.some((b) => b.startsWith('WEBSOCKET')), 'WebSocket attempts are recorded');
  } finally {
    await session.close();
    server.close();
  }
});

test('without the gateway, the dead-proxy backstop alone keeps every connection in', async () => {
  const { server, port, connections } = await canary();
  const host = new HostServer();
  await host.listen();
  const browser = await chromium.launch(launchOptions({}));
  try {
    const origin = host.register('backstop', getAdapter('node'));
    const page = await browser.newPage(); // no egress routing on this context
    await page.goto(origin + '/');
    await page.evaluate(escapeAttempts(port));
    await page.waitForTimeout(1500);
    assert.equal(connections(), 0, 'the canary server was reached');
    // The sandbox origin itself stays reachable.
    assert.equal((await page.evaluate(() => fetch('/').then((r) => r.status))), 200);

    // Control: the same attempts from a browser without the dead proxy do reach the canary.
    const open = await chromium.launch({ headless: true, executablePath: process.env.SANDBURG_CHROMIUM });
    try {
      const control = await open.newPage();
      await control.goto(origin + '/');
      await control.evaluate(escapeAttempts(port));
      await control.waitForTimeout(1500);
      assert.ok(connections() > 0, 'control run did not reach the canary; the test would prove nothing');
    } finally {
      await open.close();
    }
  } finally {
    await browser.close();
    await host.close();
    server.close();
  }
});
