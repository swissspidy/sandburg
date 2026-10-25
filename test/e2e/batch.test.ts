/**
 * Milestone 2: parallel tabs, shared cache, isolation between sandboxes, and
 * proof that nothing leaves the browser except through the egress gateway.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { Session } from '../../src/orchestrator/session.ts';
import { HostServer, SANDBOX_DOMAIN } from '../../src/orchestrator/host-server.ts';
import { EgressGateway, newEgressStats, originMatcher } from '../../src/orchestrator/egress.ts';
import { EgressProxy } from '../../src/orchestrator/egress-proxy.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter } from '../../src/adapters.ts';
import { runBatch, type BatchItem } from '../../src/orchestrator/batch.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import { sharedInstaller } from '../../src/adapters/node/install.ts';
import { extraDependencies } from '../../src/adapters/node/install-rules.ts';
import type { Project } from '../../src/types.ts';
import { launchOptions } from '../../src/orchestrator/launch.ts';

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
    // The installs the host starts (each runs npm unless the install is on disk already). Without the
    // warm-up (which may install the same dependencies), the batch's ten requests must share one.
    const installer = sharedInstaller() as unknown as {
      doInstall: (key: string, ...rest: unknown[]) => Promise<unknown>;
      plan: (project: Project, extra: Record<string, string>) => { key: string };
    };
    const doInstall = installer.doInstall;
    const started: string[] = [];
    installer.doInstall = (key, ...rest) => (started.push(key), doInstall.call(installer, key, ...rest));
    const { summary, results } = await runBatch(session, items, { parallel: 8, outDir, batchDir, prewarm: false });
    assert.equal(summary.totals.passed, 10, JSON.stringify(results.filter((r) => r.status !== 'passed').map((r) => [r.failure, r.checks.filter((c) => c.status !== 'passed')]), null, 2));
    assert.equal(summary.runs.length, 10);
    assert.equal(new Set(summary.runs.map((r) => r.snapshotId)).size, 10);
    // Each run found its own renderer (one per sandbox) and read its memory: an app's peak is a few
    // hundred MB, never the browser's whole.
    if (process.platform === 'linux') {
      for (const r of summary.runs) assert.ok(r.rendererPeakBytes! > 50 * 2 ** 20 && r.rendererPeakBytes! < 2 * 2 ** 30, `${r.label}: ${r.rendererPeakBytes}`);
      assert.equal(new Set(results.map((r) => r.memory?.rendererPeakBytes)).size > 1, true, 'each its own renderer');
    }
    // One install on the host serves all ten (they share their dependencies): the runs that start
    // after it finished take it from the cache. How long the install itself takes depends on npm's
    // cache, so its time is not checked.
    const batchKey = installer.plan(items[0].project as Project, extraDependencies(items[0].project as Project)).key;
    assert.equal(started.filter((k) => k === batchKey).length, 1, 'installs of the batch started on the host');
    const later = results.slice(8).map((r) => r.timings.installMs ?? Infinity);
    assert.ok(later.every((ms) => ms < 5000), `the two runs after the first eight installed in ${later.join(', ')} ms`);
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
    // A browser that closes resets its connections; that is not the test's failure.
    socket.on('error', () => {});
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, connections: () => count };
}

/** Every way an app can open a connection, aimed at `target`. */
function escapeAttempts(port: number, more: string[] = []): string {
  const targets = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, 'https://example.com', ...more];
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
  try {
    await session.open();
    const project = variant('escape', {
      // A *.sandburg.localhost name on another port than the host server's is not a sandbox origin.
      'src/main.tsx': (counter.files['src/main.tsx'] as string) + escapeAttempts(port, [`http://escape.${SANDBOX_DOMAIN}:${port}`]),
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
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'example.com', `escape.${SANDBOX_DOMAIN}:${port}`]) {
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
  let browser: Browser | undefined;
  try {
    await host.listen();
    browser = await chromium.launch(launchOptions({}));
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
      for (let waited = 0; connections() === 0 && waited < 5000; waited += 50) await control.waitForTimeout(50);
      assert.ok(connections() > 0, 'control run did not reach the canary; the test would prove nothing');
    } finally {
      await open.close();
    }
  } finally {
    await browser?.close();
    await host.close();
    server.close();
  }
});

test('the gateway sees HTTPS from pages and workers; another sandbox refuses requests', async () => {
  const host = new HostServer();
  const cacheDir = await mkdtemp(join(tmpdir(), 'sandburg-egress-'));
  const stats = newEgressStats();
  const allow = ['https://allowed.sandburg.test'];
  const proxy = new EgressProxy(originMatcher(allow), stats, { noTunnels: true });
  let browser: Browser | undefined;
  try {
    await host.listen();
    await proxy.listen();
    browser = await chromium.launch(launchOptions({}));
    const one = host.register('one', getAdapter('node'));
    const two = host.register('two', getAdapter('node'));
    // As a run's context (session.ts): only the host server's port bypasses the proxy, which opens no tunnels.
    const context = await browser.newContext({ proxy: { server: proxy.server, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}:${host.port}` } });
    // Offline: every request the gateway sees and has no answer for is recorded as a miss. One
    // answer is cached: the registry's kind, a 404 without CORS headers.
    const page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cached = 'https://allowed.sandburg.test/missing-package';
    const key = createHash('sha256').update(`GET ${cached}\n${userAgent}`).digest('hex');
    await mkdir(join(cacheDir, key.slice(0, 2)), { recursive: true });
    await writeFile(join(cacheDir, key.slice(0, 2), `${key}.body`), 'not found');
    await writeFile(join(cacheDir, key.slice(0, 2), `${key}.json`), JSON.stringify({ url: cached, status: 404, headers: { 'content-type': 'text/plain' } }));
    await new EgressGateway({ cacheDir, offline: true }).attach(context, one, allow, stats);
    // A page of the sandbox's origin without its service worker (whose requests no routing sees).
    await page.goto(`${one}/__sandburg/none`);
    // Its origin is allowed to read the answer, as with Playwright's routing.
    const missing = await page.evaluate((url) => fetch(url).then(async (r) => `${r.status} ${await r.text()}`), cached);
    assert.equal(missing, '404 not found');
    assert.equal(stats.cacheHits, 1);
    const loads = await page.evaluate(async (two) => {
      const nested = `fetch('https://allowed.sandburg.test/nested').catch(() => {}).finally(() => postMessage('done'));`;
      const outer = `fetch('https://allowed.sandburg.test/worker').catch(() => {});
        fetch('https://allowed.sandburg.test/worker-post', { method: 'POST', body: 'x' }).catch(() => {});
        fetch('https://blocked.sandburg.test/worker').catch(() => {});
        const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(nested)}], { type: 'text/javascript' })));
        w.onmessage = () => postMessage('done');`;
      await fetch('https://allowed.sandburg.test/page').catch(() => {});
      await fetch('https://blocked.sandburg.test/page').catch(() => {});
      await new Promise((resolve) => {
        const w = new Worker(URL.createObjectURL(new Blob([outer], { type: 'text/javascript' })));
        w.onmessage = resolve;
      });
      const load = (src: string) =>
        new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = () => resolve('loaded');
          s.onerror = () => resolve('refused');
          document.head.append(s);
        });
      return { own: await load('/__sandburg/ws-shim.js'), other: await load(`${two}/__sandburg/ws-shim.js`) };
    }, two);
    // A popup's first request comes before its interception is set: the proxy refuses it (no tunnel)
    // instead of passing it to the allowlisted origin.
    const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => void window.open('https://allowed.sandburg.test/popup'))]);
    await popup.waitForLoadState().catch(() => {});
    await popup.close();
    assert.equal(stats.tunneled, 0, JSON.stringify(stats));
    assert.ok(stats.blocked.some((b) => b.method === 'CONNECT' && b.url === 'https://allowed.sandburg.test' && /did not intercept/.test(b.reason)), JSON.stringify(stats.blocked));
    const missed = stats.failed.map((f) => new URL(f.url).pathname).sort();
    assert.deepEqual(missed, ['/nested', '/page', '/worker'], JSON.stringify(stats));
    assert.ok(stats.failed.every((f) => f.reason.startsWith('offline mode')), JSON.stringify(stats.failed));
    assert.ok(stats.blocked.some((b) => b.url === 'https://blocked.sandburg.test/page' && b.reason === 'origin not allowlisted'), JSON.stringify(stats.blocked));
    // A worker's requests meet the same rules as the page's: origin allowlist, and only GET/HEAD upstream.
    assert.ok(stats.blocked.some((b) => b.url === 'https://blocked.sandburg.test/worker' && b.reason === 'origin not allowlisted'), JSON.stringify(stats.blocked));
    assert.ok(stats.blocked.some((b) => b.url === 'https://allowed.sandburg.test/worker-post' && b.method === 'POST'), JSON.stringify(stats.blocked));
    assert.deepEqual(loads, { own: 'loaded', other: 'refused' });
    await context.close();
  } finally {
    await proxy.close();
    await browser?.close();
    await host.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
