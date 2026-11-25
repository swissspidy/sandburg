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
import { readdir, readFile, rm, stat } from 'node:fs/promises';
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
    // Another run on this .sandburg/ (a second copy of this suite) may remove or replace it meanwhile.
    const text = await readFile(join(dir, name), 'utf8').catch(() => null);
    if (text === null) continue;
    const paths = Object.keys(JSON.parse(text) as object);
    if (paths.some((p) => p.startsWith('.next/'))) seeds.set(join(dir, name), paths);
  }
  return seeds;
}

/**
 * The Next.js seed runs' results (.sandburg/seeds) since `since` (ms), for a failure to say what they
 * did: each one's project (its router), status, failure, and why its cache was not stored if its page
 * said so (browser.ts's dispose).
 */
async function seedRuns(since: number): Promise<string> {
  const dir = fileURLToPath(new URL('../../.sandburg/seeds', import.meta.url));
  const lines: string[] = [];
  for (const run of await readdir(dir).catch(() => [] as string[])) {
    const result = await readFile(join(dir, run, 'result.json'), 'utf8')
      .then((t) => JSON.parse(t) as { project?: { path?: string }; status?: string; startedAt?: string; finishedAt?: string; failure?: { message?: string } | null; console?: { text?: string }[] })
      .catch(() => null);
    if (!result) {
      // A run that wrote no result (it did not end): listed if its directory was made during the test.
      if (((await stat(join(dir, run)).catch(() => null))?.mtimeMs ?? 0) >= since) lines.push(`${run}: no result`);
      continue;
    }
    // A Next.js seed run started during the test (one without a start time counts if it is a Next.js seed's).
    const started = result.startedAt === undefined ? Number.NaN : Date.parse(result.startedAt);
    if (!result.project?.path?.startsWith('sandburg:next-') || started < since) continue;
    const unstored = (result.console ?? []).map((c) => c.text ?? '').filter((t) => t.includes('was not stored'));
    lines.push(`${run} ${result.project?.path}: ${result.status} ${result.startedAt} to ${result.finishedAt}${result.failure ? `, ${result.failure.message}` : ''}${unstored.length ? `; ${unstored.join('; ')}` : ''}`);
  }
  return `seed runs (${lines.length}):\n${lines.join('\n')}`;
}

/** The key of a Next.js seed (nextSeedKey in src/adapters/node/index.ts): a digest of public inputs. */
function seedKey(resolved: Record<string, string>, router: 'app' | 'pages'): string {
  const versions = { next: resolved.next, react: resolved.react, 'react-dom': resolved['react-dom'] };
  return createHash('sha256').update(`next-seed\0${router === 'app' ? '' : `${router}\0`}${JSON.stringify(versions)}\0${NODE_VERSION}\0${TRANSFORM_VERSION}`).digest('hex').slice(0, 24);
}

// First: later tests start from the seed it stores.
test('the first Next.js app of each router starts a seed run beside it, which stores all of webpack\'s cache, and the app cannot write it first', async () => {
  const began = Date.now();
  for (const file of (await nextSeeds()).keys()) await Promise.all([rm(file, { force: true }), rm(`${file}.bin`, { force: true })]);
  // The versions each app's install resolved, from which its page could compute its seed's key.
  const resolved = new Map<string, Record<string, string>>();
  const hostInstall = node.hostInstall!;
  node.hostInstall = async (project, log, options) => {
    const host = (await hostInstall.call(node, project, log, options)) as { resolved: Record<string, string> };
    if (!options?.seed) resolved.set(project.name, host.resolved);
    return host;
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
  if (seeds.length !== 2) assert.fail(`${seeds.length} seeds stored, not 2: ${[...stored.keys()].join(', ') || 'none'}\n${await seedRuns(began)}`);
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

// After the tests that count the stored seeds: an app's own webpack cache is stored as a seed is.
test('a Next.js app whose next.config the seed is not for keeps a webpack cache of its own, which its later runs start from', async () => {
  const dir = fixture('next-app-router');
  const plain = await loadProject(dir);
  // A webpack function: another cache version than the seed's (Next.js derives it from next.config).
  const custom = projectFromFiles({ ...plain.files, 'next.config.ts': 'export default { webpack: (config: unknown) => config };\n' }, { name: 'next-own-webpack-cache', path: 'next-own-webpack-cache' });
  const checks = ((await import(`${dir}/checks.spec.ts`)) as { default: Checks }).default;
  const installs: { name: string; filesBundle: string | null; keep?: { key: string } }[] = [];
  // The custom app's own cache: removed after the test (taken here, before a run that fails could
  // still store it), so that it starts from the seed when run again (alone).
  let ownKey: string | undefined;
  const hostInstall = node.hostInstall!;
  node.hostInstall = async (project, log, options) => {
    const host = (await hostInstall.call(node, project, log, options)) as { filesBundle: string | null; devCache?: { keep?: { key: string } } };
    if (!options?.seed) installs.push({ name: project.name, filesBundle: host.filesBundle, keep: host.devCache?.keep });
    if (project.name === custom.name) ownKey ??= host.devCache?.keep?.key;
    return host;
  };
  const cacheDir = fileURLToPath(new URL('../../.sandburg/dev-cache', import.meta.url));
  const storedAt = (key: string) => stat(join(cacheDir, `${key}.json`)).then((s) => s.mtimeMs, () => null);
  const run = async (project: typeof plain) => {
    const result = await session.run(project, { checks, outDir });
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
    return installs.at(-1)!;
  };
  try {
    // The seed is for the fixture's config: it keeps nothing of its own.
    const fits = await run(plain);
    assert.ok(fits.keep, 'the app has a seed to start from (the first test stores it)');
    assert.equal(await storedAt(fits.keep.key), null);
    // Its first run starts from the seed, which webpack does not read, and keeps its own cache.
    const first = await run(custom);
    assert.ok(first.keep && first.filesBundle !== `/__sandburg/dev-cache/${first.keep.key}/bundle`, JSON.stringify(first));
    const kept = await storedAt(first.keep.key);
    assert.ok(kept !== null, 'the run kept a cache of its own');
    const paths = Object.keys(JSON.parse(await readFile(join(cacheDir, `${first.keep.key}.json`), 'utf8')) as object);
    for (const compiler of ['client', 'server']) assert.ok(paths.includes(`.next/dev/cache/webpack/${compiler}-development/index.pack.gz`), paths.join('\n'));
    // A later run starts from it, and stores nothing (its cache is for its version).
    const second = await run(custom);
    assert.equal(second.filesBundle, `/__sandburg/dev-cache/${first.keep.key}/bundle`);
    assert.equal(await storedAt(first.keep.key), kept);
  } finally {
    node.hostInstall = hostInstall;
    if (ownKey) for (const name of [`${ownKey}.json`, `${ownKey}.json.bin`, `${ownKey}.json.digests`]) await rm(join(cacheDir, name), { force: true });
  }
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

// The page's server sees Host: localhost:3000 (process.ts), and an app that builds absolute URLs from
// it (Express' `http://${req.get('host')}/…`) puts that origin in its markup: not the page's origin.
test('a page whose markup loads its assets from http://localhost:<port> (URLs built from Host) gets them', async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'absolute-assets', private: true, scripts: { dev: 'node server.js' } }),
      'server.js': [
        "const assets = {",
        "  '/style.css': ['text/css', 'h1 { color: rgb(0, 128, 0); }'],",
        "  '/classic.js': ['text/javascript', \"document.querySelector('#classic').textContent = 'classic ran';\"],",
        "  '/module.js': ['text/javascript', \"document.querySelector('#module').textContent = 'module ran';\"],",
        "  '/pixel.svg': ['image/svg+xml', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"7\" height=\"5\"/>'],",
        "  '/same.css': ['text/css', '#same { color: rgb(0, 0, 255); }'],",
        "  '/real.css': ['text/css', '#redirected { color: rgb(128, 0, 128); }'],",
        "};",
        // A localhost port where nothing listens is still a refused connection to the program.
        "let refused = 'pending';",
        "require('node:http').get('http://localhost:3999/', () => (refused = 'answered')).on('error', (e) => (refused = e.code));",
        "require('node:http').createServer((q, s) => {",
        "  if (q.url === '/refused') return s.end(refused);",
        "  const asset = assets[q.url];",
        "  if (asset) return s.writeHead(200, { 'content-type': asset[0] }).end(asset[1]);",
        "  const base = 'http://' + q.headers.host;",
        // A redirect to another path of the same server, by its absolute URL.
        "  if (q.url === '/moved.css') return s.writeHead(302, { location: base + '/same.css' }).end();",
        "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head>' +",
        "    '<link rel=\"stylesheet\" href=\"' + base + '/style.css\">' +",
        "    '<link rel=\"stylesheet\" href=\"' + base + '/moved.css\">' +",
        "    '<link rel=\"stylesheet\" href=\"http://localhost:3001/redirect.css\">' +",
        "    '<script src=\"' + base + '/classic.js\" defer></script>' +",
        "    '<script type=\"module\" src=\"' + base.replace('localhost', '127.0.0.1') + '/module.js\"></script>' +",
        "    '</head><body><h1>' + base + '</h1><p id=\"classic\"></p><p id=\"module\"></p><p id=\"same\">same</p><p id=\"redirected\">redirected</p><img alt=\"pixel\" src=\"' + base + '/pixel.svg\"></body></html>');",
        "}).listen(3000);",
        // Another server, whose stylesheet redirects to the page's server: the browser must get it from 3000.
        "require('node:http').createServer((q, s) => s.writeHead(302, { location: 'http://localhost:3000/real.css' }).end()).listen(3001);",
      ].join('\n'),
    },
    { name: 'absolute-assets', path: 'absolute-assets' },
  );
  const result = await session.run(project, {
    outDir,
    checks: {
      assets: async ({ app, expect }) => {
        const heading = app.getByRole('heading', { level: 1 });
        await expect(heading).toHaveText('http://localhost:3000');
        await expect(heading).toHaveCSS('color', 'rgb(0, 128, 0)');
        await expect(app.locator('#classic')).toHaveText('classic ran');
        await expect(app.locator('#module')).toHaveText('module ran');
        await expect(app.getByAltText('pixel')).toHaveJSProperty('naturalWidth', 7);
        // Redirects: to another path of the same server, and from another server's URL to the page's server.
        await expect(app.locator('#same')).toHaveCSS('color', 'rgb(0, 0, 255)');
        await expect(app.locator('#redirected')).toHaveCSS('color', 'rgb(128, 0, 128)');
        await expect.poll(() => app.evaluate(async () => (await fetch('/refused')).text())).toBe('ECONNREFUSED');
      },
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

// On the developer's machine, a server's own fetch() of its localhost URL is Node's: it sends no browser
// cookies, and the cookies it is answered with do not reach the browser. The page's requests do both.
test("a server's own fetch() of its localhost URL carries no page cookies, and its answer's cookies stay out of the page", async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'server-fetch-cookies', private: true, scripts: { dev: 'node server.js' } }),
      'server.js': [
        "require('node:http').createServer(async (q, s) => {",
        "  if (q.url === '/echo') return s.writeHead(200, { 'set-cookie': 'from=' + (q.headers['x-from'] || 'page') + '; Path=/' }).end('cookie=' + (q.headers.cookie || ''));",
        "  if (q.url === '/probe') return s.end(await (await fetch('http://localhost:3000/echo', { headers: { 'x-from': 'server' } })).text());",
        // A worker of the app's own, named as the runtime's script is: its fetch() is the page's.
        "  if (q.url === '/workers/__sandburg/node-worker.js') return s.writeHead(200, { 'content-type': 'text/javascript' }).end(\"onmessage = async () => postMessage(await (await fetch('http://localhost:3000/echo', { headers: { 'x-from': 'worker' } })).text());\");",
        "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>cookies</title><h1>cookies</h1>');",
        "}).listen(3000);",
      ].join('\n'),
    },
    { name: 'server-fetch-cookies', path: 'server-fetch-cookies' },
  );
  const result = await session.run(project, {
    outDir,
    checks: {
      cookies: async ({ app, expect }) => {
        await expect(app.getByRole('heading', { level: 1 })).toHaveText('cookies');
        const seen = await app.evaluate(async () => {
          document.cookie = 'sess=browser; path=/';
          const server = await (await fetch('/probe')).text();
          const afterServer = document.cookie;
          const page = await (await fetch('/echo')).text();
          const afterPage = document.cookie;
          const worker = new Worker('/workers/__sandburg/node-worker.js');
          const fromWorker = await new Promise((resolve) => {
            worker.onmessage = (e) => resolve(e.data);
            worker.postMessage('go');
          });
          return { server, afterServer, page, afterPage, fromWorker };
        });
        // The server's fetch: no page cookie sent, and its answer's from=server not set in the page.
        expect(seen.server).toBe('cookie=');
        expect(seen.afterServer).toBe('sess=browser');
        // The page's own request: its cookie sent, and the answer's cookie set.
        expect(seen.page).toBe('cookie=sess=browser');
        expect(seen.afterPage).toBe('sess=browser; from=page');
        // The app's own worker, though its script is named as the runtime's: the page's cookies go with its fetch().
        expect(seen.fromWorker).toBe('cookie=sess=browser; from=page');
      },
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

// On the developer's machine another localhost port is another origin: a module script from it runs
// only as its server's CORS headers allow (the page's own port is the page's origin, see above). A
// server's own fetch() is Node's, which checks no CORS.
test("a module script from another localhost port runs as its server's CORS headers allow; a server's fetch() checks none", async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'cross-port-cors', private: true, scripts: { dev: 'node server.js' } }),
      'server.js': [
        "const run = (id) => \"document.querySelector('#\" + id + \"').textContent = 'ran';\";",
        "const cors = {",
        "  '/denied.js': {},",
        "  '/allowed.js': { origin: true },",
        "  '/star.js': { star: true },",
        "  '/creds-missing.js': { origin: true },",
        "  '/creds.js': { origin: true, credentials: true },",
        "  '/twice.js': { twice: true },",
        "};",
        "require('node:http').createServer(async (q, s) => {",
        "  if (q.url === '/probe') return s.end(await (await fetch('http://localhost:3001/denied.js')).text());",
        "  const m = (file, extra = '') => '<script type=\"module\"' + extra + ' src=\"http://localhost:3001/' + file + '.js\"></script>';",
        "  const ids = ['denied', 'allowed', 'star', 'creds-missing', 'creds', 'twice', 'deployment'];",
        // The page's real (deployment) origin, which only the page knows: a server that names it grants nothing.
        "  const deployment = '<script type=\"module\">const s = document.createElement(\"script\"); s.type = \"module\"; s.src = \"http://localhost:3001/deployment.js?o=\" + encodeURIComponent(location.origin); document.head.append(s);</script>';",
        "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head>' +",
        "    m('denied') + m('allowed') + m('star') + m('creds-missing', ' crossorigin=\"use-credentials\"') + m('creds', ' crossorigin=\"use-credentials\"') + m('twice') + deployment +",
        "    '</head><body><h1>cors</h1>' + ids.map((id) => '<p id=\"' + id + '\"></p>').join('') + '</body></html>');",
        "}).listen(3000);",
        // Another server, started after the page's (the first to listen is the app's).
        "let seenOrigin = '';",
        "require('node:http').createServer((q, s) => {",
        "  const url = new URL(q.url, 'http://localhost');",
        "  if (url.pathname === '/deployment.js') return s.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': url.searchParams.get('o') }).end(run('deployment'));",
        "  const rule = cors[q.url] || {};",
        "  if (q.url === '/allowed.js') seenOrigin = q.headers.origin || '';",
        "  const headers = { 'content-type': 'text/javascript' };",
        "  if (rule.origin) headers['access-control-allow-origin'] = q.headers.origin;",
        "  if (rule.star) headers['access-control-allow-origin'] = '*';",
        "  if (rule.credentials) headers['access-control-allow-credentials'] = 'true';",
        // The page's origin, twice: a browser reads the field as both values, which match no origin.
        "  if (rule.twice) headers['access-control-allow-origin'] = [q.headers.origin, q.headers.origin];",
        "  if (q.url === '/origin') return s.writeHead(200, { 'access-control-allow-origin': '*' }).end(seenOrigin);",
        "  s.writeHead(200, headers).end(run(q.url.slice(1, -3)));",
        "}).listen(3001);",
      ].join('\n'),
    },
    { name: 'cross-port-cors', path: 'cross-port-cors' },
  );
  const result = await session.run(project, {
    outDir,
    checks: {
      cors: async ({ app, expect }) => {
        await expect(app.getByRole('heading', { level: 1 })).toHaveText('cors');
        await expect(app.locator('#allowed')).toHaveText('ran');
        await expect(app.locator('#star')).toHaveText('ran');
        await expect(app.locator('#creds')).toHaveText('ran');
        // Not allowed by their server's headers: not run (none at all; credentials without allow-credentials).
        await expect(app.locator('#denied')).toHaveText('');
        await expect(app.locator('#creds-missing')).toHaveText('');
        // Allow-Origin sent twice, and one naming the page's real origin rather than the localhost one it was sent with.
        await expect(app.locator('#twice')).toHaveText('');
        await expect(app.locator('#deployment')).toHaveText('');
        // The server saw the page's localhost origin, as on the developer's machine.
        expect(await app.evaluate(async () => (await fetch('http://localhost:3001/origin')).text())).toBe('http://localhost:3000');
        // A server's own fetch() of a URL that sends no CORS headers gets its answer.
        expect(await app.evaluate(async () => (await fetch('/probe')).text())).toContain("textContent = 'ran'");
      },
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

test('a server that runs synchronous commands as it starts (node -p, a git revision with a fallback) runs', async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'sync-commands', private: true, scripts: { dev: 'node server.js' } }),
      'server.js': [
        "const { execSync, execFileSync } = require('node:child_process');",
        "const sum = execFileSync(process.execPath, ['-p', '6 * 7'], { encoding: 'utf8' }).trim();",
        // git is not a Node program: it exits with 127, as a command a shell cannot find.
        "let revision;",
        "try { revision = execSync('git rev-parse --short HEAD', { stdio: 'pipe' }).toString().trim(); } catch (e) { revision = 'no git (' + e.status + ')'; }",
        "require('node:http').createServer((q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end('<h1>' + sum + ', ' + revision + '</h1>')).listen(3000);",
      ].join('\n'),
    },
    { name: 'sync-commands', path: 'sync-commands' },
  );
  const result = await session.run(project, {
    outDir,
    checks: { renders: async ({ app, expect }) => expect(app.getByRole('heading', { level: 1 })).toHaveText('42, no git (127)') },
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
