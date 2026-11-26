/** sandburg serve's server (src/serve.ts, ADR 0075): what it answers, to whom, and its command line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoopback, serve, serveMain } from '../../src/serve.ts';
import { projectFromFiles } from '../../src/project.ts';
import { tempDir } from './temp-dir.ts';

const project = projectFromFiles({ 'package.json': '{"scripts":{"dev":"node s.js"}}', 's.js': 'require("http").createServer((q, s) => s.end("hi")).listen(3000);' }, { name: 'p', path: 'p' });

/** A stand-in for dist/browser-runtime: its index.js and service worker. */
function runtime(): string {
  const dir = tempDir('sandburg-serve-runtime-');
  mkdirSync(join(dir, 'runtime'));
  writeFileSync(join(dir, 'index.js'), 'export {};');
  writeFileSync(join(dir, 'sw.js'), '// sw');
  return dir;
}

/** GET `path` on the server with this Host header (fetch() does not let a caller set one). */
function get(url: string, path: string, host?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: host ?? `localhost:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject).end();
  });
}

test('it serves the page, the project as JSON and the runtime (its service worker allowed to control the page at /)', async (t) => {
  const served = await serve({ project, port: 0, runtimeDir: runtime() });
  t.after(() => served.close());
  assert.match(served.url, /^http:\/\/localhost:\d+\/$/);
  const page = await get(served.url, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /from '\/sandburg\/index\.js'/);
  const json = await get(served.url, '/sandburg-serve/project.json');
  assert.deepEqual(JSON.parse(json.body).files, project.files);
  const sw = await get(served.url, '/sandburg/sw.js');
  assert.equal(sw.headers['service-worker-allowed'], '/');
  // Not outside the runtime's directory, and the app's own paths are the service worker's.
  assert.equal((await get(served.url, '/sandburg/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await get(served.url, '/src/main.tsx')).status, 404);
});

test('bound to loopback, it answers only requests for a loopback name (no DNS rebinding of the project)', async (t) => {
  const served = await serve({ project, port: 0, runtimeDir: runtime() });
  t.after(() => served.close());
  const port = new URL(served.url).port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) assert.equal((await get(served.url, '/sandburg-serve/project.json', host)).status, 200, host);
  for (const host of [`evil.example:${port}`, 'evil.example', `localhost.evil.example:${port}`]) assert.equal((await get(served.url, '/sandburg-serve/project.json', host)).status, 403, host);
});

// Which listening address keeps the Host check on, and which Host names it accepts there: all of
// loopback, not only 127.0.0.1 (--host 127.0.0.2 is loopback too). Tested as a function: macOS does not
// let a test bind 127.0.0.2.
test('loopback is all of 127.0.0.0/8, ::1 (also IPv4-mapped and bracketed) and localhost; nothing else is', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', 'app.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) assert.ok(isLoopback(host), host);
  for (const host of ['0.0.0.0', '::', '192.168.1.2', '10.0.0.1', '128.0.0.1', '127.example', 'localhost.evil.example', 'evil.example', '::2', '::ffff:10.0.0.1', '']) assert.ok(!isLoopback(host), host);
});

test('without the browser runtime built, it says how to build it', async () => {
  await assert.rejects(serve({ project, port: 0, runtimeDir: tempDir('sandburg-serve-empty-') }), /not built at .*npm run build/);
});

test('its command line: usage errors exit 64, a project that does not load exits 2', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: string) => errors.push(m));
  assert.equal(await serveMain([]), 64);
  assert.equal(await serveMain(['a', 'b']), 64);
  assert.equal(await serveMain(['p', '--port', 'x']), 64);
  assert.equal(await serveMain(['p', '--bogus']), 64);
  assert.equal(await serveMain([join(tempDir('sandburg-serve-'), 'missing')]), 2);
  assert.match(errors.at(-1)!, /^error: /);
});
