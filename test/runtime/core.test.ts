import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

test('a Node program: fs, path, crypto, zlib, events, process', async () => {
  const out = await h.run(
    {
      'lib/greet.js': `module.exports = (n) => 'hello ' + n;`,
      'data.json': JSON.stringify({ n: 42 }),
      'main.js': `
        const fs = require('node:fs'); const path = require('path'); const crypto = require('crypto');
        const zlib = require('zlib'); const { EventEmitter, once } = require('events'); const os = require('os');
        const greet = require('./lib/greet'); const data = require('./data.json');
        fs.mkdirSync('/tmp/a/b', { recursive: true }); fs.writeFileSync('/tmp/a/b/f.txt', 'content');
        console.log(JSON.stringify({
          greet: greet('node'), n: data.n, read: fs.readFileSync('/tmp/a/b/f.txt', 'utf8'),
          list: fs.readdirSync('/tmp/a', { recursive: true }), exists: fs.existsSync('/nope'),
          rel: path.relative('/a/b/c', '/a/d'), sha: crypto.createHash('sha256').update('abc').digest('hex'),
          gz: zlib.gunzipSync(zlib.gzipSync('zip me')).toString(), node: process.version, platform: os.platform(),
          dirname: __dirname, main: require.main === module, resolved: require.resolve('./lib/greet'),
        }));
        const e = new EventEmitter(); once(e, 'x').then(([v]) => console.log('event', v)); e.emit('x', 7);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? '');
  const result = JSON.parse(out.stdout.split('\n')[0]);
  assert.deepEqual(result, {
    greet: 'hello node', n: 42, read: 'content', list: ['b', 'b/f.txt'], exists: false, rel: '../../d',
    sha: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', gz: 'zip me', node: 'v24.11.0', platform: 'linux',
    dirname: '/app', main: true, resolved: '/app/lib/greet.js',
  });
  assert.match(out.stdout, /event 7/);
});

test('http server with AsyncLocalStorage across awaits, concurrent requests', async () => {
  const out = await h.run(
    {
      'server.js': `
        const http = require('http'); const { AsyncLocalStorage } = require('async_hooks');
        const als = new AsyncLocalStorage();
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function handler(req, res) {
          await sleep(Math.random() * 20);
          const [a] = await Promise.all([ (async () => { await sleep(5); return als.getStore().id; })() ]);
          res.setHeader('content-type', 'application/json');
          res.write('{"id":' + JSON.stringify(als.getStore().id) + ',');
          await sleep(5);
          res.end('"inner":' + JSON.stringify(a) + '}');
        }
        http.createServer((req, res) => als.run({ id: req.url }, () => handler(req, res))).listen(3000, () => console.log('up'));`,
    },
    '/app/server.js',
    [{ url: '/one' }, { url: '/two' }, { url: '/three' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? '');
  assert.deepEqual(out.responses.map((r) => [r.status, JSON.parse(r.body)]), [
    [200, { id: '/one', inner: '/one' }],
    [200, { id: '/two', inner: '/two' }],
    [200, { id: '/three', inner: '/three' }],
  ]);
  assert.ok(out.responses.every((r) => r.chunks === 2), 'responses stream chunk by chunk');
});

test('ESM and TypeScript files load like in Node 24', async () => {
  const out = await h.run(
    {
      'package.json': JSON.stringify({ type: 'commonjs' }),
      'esm.mjs': `export const x = 1; export default function hi() { return 'hi from esm ' + import.meta.url; }`,
      'util.ts': `export function add(a: number, b: number): number { return a + b; }`,
      'main.js': `const m = require('./esm.mjs'); const { add } = require('./util.ts'); console.log(m.default(), m.x, add(2, 3));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? '');
  assert.equal(out.stdout.trim(), 'hi from esm file:///app/esm.mjs 1 5');
});

test('errors: missing modules, process.exit', async () => {
  const out = await h.run({ 'main.js': `try { require('nope'); } catch (e) { console.log(e.code); } process.exit(3);` }, '/app/main.js');
  assert.equal(out.stdout.trim(), 'MODULE_NOT_FOUND');
  assert.equal(out.exit, 3);
});
