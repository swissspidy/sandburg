/**
 * End-to-end: real Chromium and the node runtime: the Vite + React fixture runs
 * on its own Vite dev server, Next.js on next dev. The first run needs network
 * access to the npm registry; later runs use caches.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Session, type RunRenderer } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import type { Project } from '../../src/types.ts';
import type { CheckContext, Checks } from '../../src/orchestrator/checks.ts';
import type { Browser } from 'playwright-core';

const fixtureDir = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
let session: Session;
let counter: Project;

before(async () => {
  session = new Session();
  await session.open();
  counter = await loadProject(fixtureDir);
});
after(() => session.close());

/** The counter fixture with some files replaced. */
function variant(name: string, files: Record<string, string>): Project {
  return projectFromFiles({ ...counter.files, ...files }, { name, path: `${fixtureDir}#${name}` });
}

test('milestone 1: the Vite + React fixture runs and its functional checks pass', async () => {
  const result = await session.run(counter, { checks: `${fixtureDir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  assert.equal(result.failure, null);
  assert.equal(result.runtime.name, 'node');
  const functional = result.checks.filter((c) => c.kind === 'functional');
  assert.equal(functional.length, 2);
  assert.ok(functional.every((c) => c.status === 'passed'));
  for (const key of ['loadMs', 'mountMs', 'installMs', 'startMs', 'readyMs', 'checksMs'] as const) {
    assert.equal(typeof result.timings[key], 'number', key);
  }
  // The versions npm installed for the declared ranges (^19.3.0).
  assert.match(result.install?.dependencies?.react ?? '', /^19\.\d+\.\d+$/);
  assert.match(result.install?.dependencies?.['react-dom'] ?? '', /^19\.\d+\.\d+$/);
  assert.ok(result.artifacts.screenshot);
  await access(result.artifacts.screenshot);

  // Schema stability: every run carries exactly the top-level fields of schema v1.
  const schema = JSON.parse(await readFile(new URL('../../src/result-schema.json', import.meta.url), 'utf8'));
  // (and of its optional fields, only those it has: a run on Linux reports its renderer's memory)
  const optional = Object.keys(schema.properties).filter((k) => !schema.required.includes(k));
  assert.deepEqual(Object.keys(result).sort(), ([...schema.required, ...optional.filter((k) => k in result)] as string[]).sort());
  if (process.platform === 'linux') assert.ok(result.memory!.rendererPeakBytes > 50 * 2 ** 20, JSON.stringify(result.memory));
  assert.deepEqual(Object.keys(result.timings).sort(), ([...schema.properties.timings.required] as string[]).sort());
});

test("a run's renderer is found, and collecting its garbage in its checks leaves the run passing", { skip: process.platform !== 'linux' }, async () => {
  let renderer: RunRenderer | undefined;
  let collected: Promise<{ before: number | null; after: number | null; ms: number }> | undefined;
  const result = await session.run(counter, {
    checks: `${fixtureDir}/checks.spec.ts`,
    outDir,
    onRenderer: (r) => (renderer = r),
    onPhase: (phase) => {
      if (phase !== 'checks' || !renderer) return;
      const r = renderer;
      collected = (async () => {
        const before = r.used();
        const started = performance.now();
        await r.collectGarbage();
        return { before, after: r.used(), ms: performance.now() - started };
      })();
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  const c = await collected!;
  assert.ok(c.before !== null && c.before > 50 * 2 ** 20, JSON.stringify(c));
  // Bounded: the blocked WebAssembly threads of Vite's bundler answer only at their timeout.
  assert.ok(c.ms < 10_000, JSON.stringify(c));
  // Over: nothing more is read (the pid may be reused), and collecting is a no-op.
  assert.equal(renderer!.used(), null);
  await renderer!.collectGarbage();
});

test('a failing functional check is classified as an app bug', async () => {
  const project = variant('off-by-one', {
    'src/App.tsx': (counter.files['src/App.tsx'] as string).replace('setCount((c) => c + 1)', 'setCount((c) => c + 2)'),
  });
  const result = await session.run(project, {
    outDir,
    checks: {
      'counter increments by one': async ({ app, expect }) => {
        await app.getByRole('button', { name: /count is/ }).click();
        await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1', { timeout: 2000 });
      },
    },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'blocking-check-failed']);
});

test('requests outside the allowlist are blocked and recorded', async () => {
  const project = variant('exfiltrate', {
    'src/main.tsx':
      (counter.files['src/main.tsx'] as string) +
      `\nfetch('https://example.com/collect').catch(() => {});\nfetch('http://192.0.2.1:8080/').catch(() => {});\nfetch('http://127.0.0.1:1/').catch(() => {});\n`,
  });
  const result = await session.run(project, { outDir });
  const blocked = result.network.blocked.map((b) => new URL(b.url).origin);
  assert.ok(blocked.includes('https://example.com'), JSON.stringify(result.network));
  assert.ok(blocked.includes('http://192.0.2.1:8080'), JSON.stringify(result.network));
  // localhost is the sandbox: the page's calls to a local port go to its own servers, never out.
  assert.ok(!JSON.stringify(result.network).includes('127.0.0.1'), JSON.stringify(result.network));
  const networkCheck = result.checks.find((c) => c.kind === 'network');
  assert.equal(networkCheck?.status, 'failed');
  assert.equal(networkCheck?.blocking, false);
});

test('a popup to an IPv6 literal is refused, and the session goes on running apps', async () => {
  // A popup's first request reaches the run's egress proxy (ADR 0030) as `CONNECT [::1]:443`: parsing
  // it threw, and the host process exited.
  const result = await session.run(counter, {
    outDir,
    checks: {
      'opens popups the gateway does not see': async ({ app }) => {
        await app.evaluate(() => {
          for (const url of ['https://[::1]/', 'https://[::1]:8443/x', 'https://[0:0:0:0:0:ffff:7f00:1]/']) window.open(url);
        });
        await new Promise((r) => setTimeout(r, 2000));
      },
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  const blocked = result.network.blocked.map((b) => b.url);
  assert.ok(blocked.includes('https://[::1]'), JSON.stringify(result.network));
  assert.ok(blocked.includes('https://[::1]:8443'), JSON.stringify(result.network));
  const again = await session.run(counter, { checks: `${fixtureDir}/checks.spec.ts`, outDir });
  assert.equal(again.status, 'passed', JSON.stringify(again.failure ?? again.checks, null, 2));
});

test('a run stores its own dev-server cache and compiles, with the capability its install issued', async () => {
  const dir = fileURLToPath(new URL('../../.sandburg/dev-cache', import.meta.url));
  const before = new Set(await readdir(dir).catch(() => [] as string[]));
  // A project of its own (a new dev-cache key), whose run has no cache to start from.
  const project = variant(`own-cache-${Date.now()}`, { 'src/marker.ts': `export const marker = ${Date.now()};\n` });
  const result = await session.run(project, { checks: `${fixtureDir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  let added: string[] = [];
  // The page stores the cache as the run ends; compiles are written 2 s after they were recorded.
  for (let i = 0; i < 40; i++) {
    added = (await readdir(dir)).filter((f) => !before.has(f));
    if (added.some((f) => /^[0-9a-f]{24}\.json$/.test(f) && added.some((c) => c.startsWith('compiled-') && c.endsWith(`-${f.slice(0, 24)}.bin`)))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // The app's cache, beside its compiles (a Vite seed run may have stored the seed of its packages too).
  const cache = added.find((f) => /^[0-9a-f]{24}\.json$/.test(f) && added.some((c) => c.startsWith('compiled-') && c.endsWith(`-${f.slice(0, 24)}.bin`)));
  assert.ok(cache, added.join('\n'));
  const kept = Object.keys(JSON.parse(await readFile(`${dir}/${cache}`, 'utf8')));
  assert.ok(kept.includes('node_modules/.vite/deps/_metadata.json'));
  // Vite's bundle of vite.config.ts, for the project's next run (node-runtime/config-bundles.ts).
  assert.ok(kept.some((f) => f.startsWith('node_modules/.vite/sandburg-transforms/vite-config/')), kept.join('\n'));
});

test('importing an undeclared package is an app bug, not a runtime limitation', async () => {
  const project = variant('undeclared', {
    // Used, so TypeScript import elision keeps it.
    'src/App.tsx': `import debounce from 'lodash/debounce';\nconsole.log(debounce);\n` + (counter.files['src/App.tsx'] as string),
  });
  const result = await session.run(project, { outDir, timeouts: { ready: 10_000 } });
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'undeclared-import']);
});

test("an error the app reports while its page never finishes loading fails the ready phase, not its deadline", async () => {
  // The dev server never answers a script the page waits for (as Angular's did once its dependency
  // optimizer crashed): the frame's load event never comes, and the app's error is reported meanwhile.
  const project = variant('never-loads', {
    'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), { name: 'never-answer', configureServer: (server) => void server.middlewares.use((req, _res, next) => (req.url === '/never.js' ? undefined : next())) }],
});
`,
    'index.html': (counter.files['index.html'] as string).replace('<div id="root"></div>', '<script>throw new Error("the app could not start")</script>\n    <script src="/never.js"></script>\n    <div id="root"></div>'),
  });
  const result = await session.run(project, { outDir, timeouts: { ready: 60_000 } });
  const ready = result.phases.find((p) => p.name === 'ready');
  assert.equal(ready?.status, 'failed', JSON.stringify(result.failure));
  assert.match(result.failure?.message ?? '', /^app threw before rendering: the app could not start/);
  assert.ok(ready.durationMs < 30_000, `ready took ${ready.durationMs} ms`);
});

test('a ready deadline produces a timeout', async () => {
  const result = await session.run(counter, { outDir, readySelector: '#never', timeouts: { ready: 3000 } });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'timeout');
  assert.equal(result.phases.find((p) => p.name === 'ready')?.status, 'timeout');
});

test('a check that hangs is stopped and the next one runs on the app loaded again; a checks deadline keeps what finished', async () => {
  const hang = async ({ app }: CheckContext) => {
    await app.getByRole('button', { name: /count is/ }).click();
    await app.getByRole('button', { name: 'Never' }).click();
  };
  const checks: Checks = {
    'hangs after a click': hang,
    // One click from 0: the click the check before it made did not carry over.
    'counts from zero': async ({ app, expect }) => {
      const button = app.getByRole('button', { name: /count is/ });
      await button.click();
      await expect(button).toHaveText('count is 1');
    },
    'hangs again': hang,
    'and again': hang,
  };
  // 3 s per check, 8 s for them all: the deadline comes in the second or third hanging check.
  const result = await session.run(counter, { checks, outDir, timeouts: { check: 3_000, checks: 8_000 } });
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.phase], ['timeout', 'checks']);
  const by = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  for (const name of ['Screenshot', 'Accessibility tree snapshot', 'axe-core accessibility scan']) assert.equal(by[name]?.status, 'passed', name);
  await access(result.artifacts.screenshot!);
  await access(result.artifacts.a11ySnapshot!);
  assert.equal(by['hangs after a click'].status, 'failed');
  assert.match(by['hangs after a click'].message!, /timed out\nThe check was stopped, and the app loaded again before the next check\./);
  assert.equal(by['counts from zero'].status, 'passed', JSON.stringify(by['counts from zero']));
  // The check running at the deadline failed; those after it did not run.
  const rest = ['hangs again', 'and again', 'The page is not a server error', 'No uncaught errors in the app', 'No failed or blocked requests'].map((n) => by[n]);
  const cut = rest.findIndex((c) => c.message === 'timed out: checks did not finish within 8000 ms');
  assert.ok(cut === 0 || cut === 1, JSON.stringify(rest, null, 2));
  assert.equal(rest[cut].status, 'failed');
  assert.ok(rest.slice(cut + 1).every((c) => c.status === 'skipped' && c.message === 'not run: checks did not finish within 8000 ms'), JSON.stringify(rest, null, 2));
});

test('a held run (sandburg open) keeps its tab open when a phase before the checks fails, until it is closed', async () => {
  let readyStarted!: () => void;
  const ready = new Promise<void>((r) => (readyStarted = r));
  let settled = false;
  const run = session.run(counter, { outDir, hold: true, readySelector: '#never', timeouts: { ready: 1000 }, onPhase: (p) => p === 'ready' && readyStarted() });
  void run.finally(() => (settled = true));
  await ready;
  // Past the ready deadline (1 s), the run waits for its window, open, instead of ending.
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(settled, false);
  const browser = (session as unknown as { browser: Browser }).browser;
  const pages = browser.contexts().flatMap((c) => c.pages());
  assert.ok(pages.length && pages.every((p) => !p.isClosed()));
  await Promise.all(pages.map((p) => p.close()));
  const result = await run;
  assert.equal(result.failure?.class, 'timeout');
  assert.equal(result.phases.find((p) => p.name === 'ready')?.status, 'timeout');
});

test('projects the runtime cannot start are rejected before a tab opens', async () => {
  const library = projectFromFiles(
    { 'package.json': JSON.stringify({ name: 'a-library', scripts: { test: 'node --test' } }), 'lib.js': 'module.exports = 1;' },
    { name: 'a-library', path: 'a-library' },
  );
  const result = await session.run(library, { outDir });
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['runtime-unsupported', 'probe-unsupported']);
  assert.equal(result.timings.loadMs, null);
});

const nextDir = fileURLToPath(new URL('../../fixtures/next-app-router', import.meta.url));

test('a broken Next.js API route is an app bug', async () => {
  const next = await loadProject(nextDir);
  const project = projectFromFiles(
    { ...next.files, 'app/api/greeting/route.ts': `export async function GET() { throw new Error('database unavailable'); }` },
    { name: 'next-broken-api', path: `${nextDir}#broken-api` },
  );
  const result = await session.run(project, { checks: `${nextDir}/checks.spec.ts`, outDir });
  assert.equal(result.runtime.name, 'node');
  assert.equal(result.status, 'failed');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'blocking-check-failed']);
  assert.equal(result.checks.find((c) => c.name === 'API route answers')?.status, 'failed');
  assert.equal(result.checks.find((c) => c.name === 'a habit can be added')?.status, 'passed');
});
