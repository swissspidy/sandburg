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
          u8: [Buffer.from('abcabc').indexOf(new Uint8Array([99, 97])), Buffer.from('ab').equals(new Uint8Array([97, 98]))],
          slices: (() => { const b = Buffer.from([0x63, 0x61, 0x66, 0xe9]); const w = Buffer.alloc(4); w.latin1Write('caf\u00e9', 0, 4);
            return [b.latin1Slice(0, 4), b.asciiSlice(0, 3), b.hexSlice(1, 3), b.base64Slice(0, 4), w.equals(b)]; })(),
          channel: (() => { const c = new BroadcastChannel('t'); const same = c.unref() === c && c.ref() === c; c.close(); return same; })(),
          ts: process.features.typescript,
        }));
        const e = new EventEmitter(); once(e, 'x').then(([v]) => console.log('event', v)); e.emit('x', 7);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? '');
  const result = JSON.parse(out.stdout.split('\n')[0]);
  assert.deepEqual(result, {
    greet: 'hello node', n: 42, read: 'content', list: ['b', 'b/f.txt'], exists: false, rel: '../../d',
    sha: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', gz: 'zip me', node: 'v24.15.0', platform: 'linux',
    dirname: '/app', main: true, resolved: '/app/lib/greet.js', u8: [2, true], ts: 'strip',
    slices: ['caf\u00e9', 'caf', '6166', 'Y2Fm6Q==', true], channel: true,
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

test('top-level await: modules evaluate after the dependencies they await, and rejections are fatal', async () => {
  const out = await h.run(
    {
      'package.json': JSON.stringify({ type: 'module' }),
      'db.js': `
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(50);
        export const db = { ready: true, rows: [1, 2, 3] };
        console.log('db ready');`,
      'repo.js': `
        import { db } from './db.js';
        // Runs only after db.js has finished its top-level await.
        export const count = db.rows.length;
        console.log('repo', db.ready);`,
      'main.js': `
        import { count } from './repo.js';
        const extra = await Promise.resolve(10);
        console.log('main', count + extra);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['db ready', 'repo true', 'main 13']);

  // import() from CommonJS (as a tool loads a config file) resolves once the module has evaluated.
  const dynamic = await h.run(
    {
      'config.mjs': `await new Promise((r) => setTimeout(r, 50));\nexport default { name: 'app' };`,
      'main.cjs': `import('./config.mjs').then((m) => console.log('config', JSON.stringify(m.default), typeof m.then));`,
    },
    '/app/main.cjs',
  );
  assert.equal(dynamic.fatal, null, dynamic.fatal ?? dynamic.stderr);
  assert.equal(dynamic.stdout.trim(), 'config {"name":"app"} undefined', dynamic.stderr);

  const failed = await h.run({ 'main.mjs': `await Promise.reject(new Error('cannot connect to the database'));` }, '/app/main.mjs');
  assert.match(failed.fatal ?? '', /cannot connect to the database/);
});

/** A WebSocket server written against the raw upgrade socket, as `ws` does it. */
const RAW_WS_SERVER = `
  const http = require('http');
  const crypto = require('crypto');
  const server = http.createServer((req, res) => res.end('plain http'));
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/chat') { socket.end('HTTP/1.1 404 Not Found\\r\\n\\r\\n'); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Protocol: chat.v1\\r\\n\\r\\n');
    const frame = (op, payload, fin = true) => Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, payload.length]), payload]);
    socket.write(frame(0x9, Buffer.from('are you there')));           // ping: the client must pong
    socket.write(frame(0x1, Buffer.from('hel'), false));               // a fragmented text message
    socket.write(frame(0x0, Buffer.from('lo')));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 6) {
        const op = buf[0] & 0x0f, len = buf[1] & 0x7f, masked = (buf[1] & 0x80) !== 0;
        if (!masked) throw new Error('client frames must be masked');
        const mask = buf.subarray(2, 6), data = Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(6 + len);
        if (op === 0xa) socket.write(frame(0x1, Buffer.from('pong: ' + data.toString())));
        else if (op === 0x1) socket.write(frame(0x1, Buffer.from('echo: ' + data.toString())));
        else if (op === 0x2) socket.write(frame(0x2, Buffer.from(data.reverse())));
        else if (op === 0x8) { socket.write(frame(0x8, data)); socket.end(); }
      }
    });
  });
  server.listen(3000);
`;

test('WebSockets: upgrade, subprotocol, ping/pong, fragments, text, close', async () => {
  const out = await h.runWebSocket({ 'main.js': RAW_WS_SERVER }, '/app/main.js', '/chat', ['chat.v1'], ['hi', 'CLOSE']);
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.events, [
    ['open', 'chat.v1'],
    // The server wrote "hello" before it could have received the pong.
    ['message', 'hello'],
    ['message', 'pong: are you there'],
    ['message', 'echo: hi'],
    ['closed', 1000, 'bye', true],
  ]);
});

test('WebSockets: a path the server rejects, and a server without upgrade handling', async () => {
  const rejected = await h.runWebSocket({ 'main.js': RAW_WS_SERVER }, '/app/main.js', '/nope', [], []);
  assert.deepEqual(rejected.events, [['reject', 404, '']]);
  const plain = await h.runWebSocket({ 'main.js': `require('http').createServer((q, s) => s.end()).listen(3000);` }, '/app/main.js', '/', [], []);
  assert.deepEqual(plain.events, [['reject', 404, 'the server does not accept WebSocket connections']]);
});

test('worker_threads: workerData, messages, a shared file system, SharedArrayBuffer + Atomics, exit codes', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { Worker } = require('worker_threads');
        const fs = require('fs');
        const shared = new Int32Array(new SharedArrayBuffer(8));
        const w = new Worker(require('path').join(__dirname, 'child.js'), { workerData: { greeting: 'hi', shared } });
        fs.writeFileSync('/app/after-spawn.txt', 'written by the parent after the spawn');
        w.on('online', () => console.log('online'));
        w.on('message', (m) => {
          if (m.type === 'ready') { w.postMessage({ type: 'go' }); return; }
          console.log('from child:', JSON.stringify(m));
          console.log('child wrote:', fs.readFileSync('/app/from-child.txt', 'utf8'));
          console.log('atomics:', Atomics.load(shared, 0));
        });
        w.on('exit', (code) => console.log('exit', code));
        const e = new Worker('throw new Error("boom in thread")', { eval: true });
        e.on('error', (err) => console.log('error event:', err.message));
        e.on('exit', (code) => console.log('eval exit', code));`,
      'child.js': `
        const { parentPort, workerData, isMainThread, threadId } = require('worker_threads');
        const fs = require('fs');
        parentPort.postMessage({ type: 'ready' });
        parentPort.on('message', () => {
          Atomics.add(workerData.shared, 0, 42);
          fs.writeFileSync('/app/from-child.txt', 'written by the thread');
          parentPort.postMessage({ greeting: workerData.greeting, isMainThread, threadId: threadId > 0, read: fs.readFileSync('/app/after-spawn.txt', 'utf8') });
          setTimeout(() => process.exit(7), 20);
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.ok(lines.includes('online'), out.stdout);
  assert.ok(lines.includes('from child: {"greeting":"hi","isMainThread":false,"threadId":true,"read":"written by the parent after the spawn"}'), out.stdout);
  assert.ok(lines.includes('child wrote: written by the thread'), out.stdout);
  assert.ok(lines.includes('atomics: 42'), out.stdout);
  assert.ok(lines.includes('exit 7'), out.stdout);
  assert.ok(lines.includes('error event: boom in thread'), out.stdout);
  assert.ok(lines.includes('eval exit 1'), out.stdout);
});

test('child_process: node children with stdio, exit codes, --conditions, fork() IPC and exec()', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { spawn, fork, exec } = require('child_process');
        const fs = require('fs');
        fs.writeFileSync('/app/from-parent.txt', 'shared');
        const c = spawn(process.execPath, ['--conditions=custom', 'child.js', 'one', 'two'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GREETING: 'hello' } });
        let text = '';
        c.stdout.on('data', (d) => (text += d));
        c.on('exit', (code) => {
          console.log('child exit', code);
          console.log('child said', JSON.stringify(text.trim()));
          const f = fork('./ipc.js');
          f.on('message', (m) => {
            console.log('from fork', m.pong);
            f.disconnect();
          });
          f.on('exit', (code) => {
            console.log('fork exit', code);
            exec('node -e "console.log(6 * 7)"', (err, stdout) => {
              console.log('exec', err, stdout.trim());
              exec('git status', (err) => {
                console.log('git', err.code);
                process.exit(0);
              });
            });
          });
          f.send({ ping: 1 });
        });`,
      'child.js': `
        const fs = require('fs');
        console.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env.GREETING, execArgv: process.execArgv, pkg: require('pkg'), read: fs.readFileSync('/app/from-parent.txt', 'utf8') }));
        process.exitCode = 3;
        setTimeout(() => process.exit(), 10);`,
      'ipc.js': `
        process.on('message', (m) => process.send({ pong: m.ping + 1 }));
        process.on('disconnect', () => process.exit(5));`,
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { custom: './custom.js', default: './default.js' } }),
      'node_modules/pkg/custom.js': `module.exports = 'custom';`,
      'node_modules/pkg/default.js': `module.exports = 'default';`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.ok(lines.includes('child exit 3'), out.stdout + out.stderr);
  assert.ok(lines.includes(`child said ${JSON.stringify(JSON.stringify({ argv: ['one', 'two'], env: 'hello', execArgv: ['--conditions=custom'], pkg: 'custom', read: 'shared' }))}`), out.stdout);
  assert.ok(lines.includes('from fork 2'), out.stdout);
  assert.ok(lines.includes('fork exit 5'), out.stdout);
  assert.ok(lines.includes('exec null 42'), out.stdout);
  assert.ok(lines.includes('git 127'), out.stdout);
});

test('child_process: servers in a child process are reachable', async () => {
  const out = await h.run(
    {
      'main.js': `require('child_process').spawn(process.execPath, ['server.js'], { stdio: 'inherit' });`,
      'server.js': `require('http').createServer((req, res) => res.end('from the child: ' + req.url)).listen(4000, () => console.log('child listening'));`,
    },
    '/app/main.js',
    [{ url: '/hello' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.match(out.stdout, /child listening/);
  assert.deepEqual(out.responses[0], { status: 200, body: 'from the child: /hello', chunks: 1 });
});

test('http: requests to localhost and local sockets reach virtual servers, also in threads', async () => {
  const out = await h.run(
    {
      'main.js': `
        const http = require('http');
        const { Worker } = require('worker_threads');
        const get = (opts) => new Promise((resolve, reject) => {
          http.get(opts, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve(res.statusCode + ' ' + body));
          }).on('error', reject);
        });
        http.createServer((req, res) => res.end('own ' + req.url + ' ' + req.headers.host)).listen(4100, async () => {
          console.log(await get('http://localhost:4100/a'));
          const w = new Worker(require('path').join(__dirname, 'thread.js'));
          w.on('message', async (address) => {
            console.log(await get({ socketPath: address, path: '/b', headers: { 'x-test': '1' } }));
            process.exit(0);
          });
        });`,
      'thread.js': `
        const http = require('http');
        const server = http.createServer((req, res) => res.end('thread ' + req.url + ' ' + req.headers['x-test']));
        server.listen('\\0test.sock', () => require('worker_threads').parentPort.postMessage(server.address()));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.ok(lines.includes('200 own /a localhost:4100'), out.stdout + out.stderr);
  assert.ok(lines.includes('200 thread /b 1'), out.stdout + out.stderr);
});

test('net: local servers and sockets, also between a thread and its parent', async () => {
  const out = await h.run(
    {
      'main.js': `
        const net = require('net');
        const { Worker } = require('worker_threads');
        const echo = (tag) => (socket) => socket.on('data', (d) => socket.write(tag + ':' + d)).on('end', () => socket.end());
        const talk = (target, text) => new Promise((resolve, reject) => {
          let got = '';
          const c = net.createConnection(target, () => c.end(text));
          c.on('data', (d) => (got += d)).on('end', () => resolve(got)).on('error', reject);
        });
        net.createServer(echo('parent')).listen('/tmp/parent.sock', async () => {
          console.log(await talk(4200, 'x').catch((e) => e.code));
          net.createServer(echo('local')).listen(4200, async () => {
            console.log(await talk({ port: 4200, host: '127.0.0.1' }, 'hi'));
            const w = new Worker(require('path').join(__dirname, 'thread.js'));
            w.on('message', async (m) => {
              if (m.fromThread) return console.log('thread got', m.fromThread);
              console.log(await talk(m.path, 'down'));
              process.exit(0);
            });
          });
        });`,
      'thread.js': `
        const net = require('net');
        const { parentPort } = require('worker_threads');
        const c = net.connect('/tmp/parent.sock', () => c.end('up'));
        let got = '';
        c.on('data', (d) => (got += d)).on('end', () => {
          parentPort.postMessage({ fromThread: got });
          net.createServer((s) => s.on('data', (d) => s.end('thread:' + d))).listen('\\0thread.sock', () => parentPort.postMessage({ path: '\\0thread.sock' }));
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.deepEqual(lines, ['ECONNREFUSED', 'local:hi', 'thread got parent:up', 'thread:down'], out.stdout + out.stderr);
});

test('Request and Response keep Cookie, Referer and Set-Cookie headers, as in Node', async () => {
  const out = await h.run(
    {
      'main.js': `
        const req = new Request('http://localhost/x', { method: 'POST', headers: { cookie: 'a=1', referer: 'http://localhost/page', origin: 'http://localhost' }, body: 'hi' });
        const res = new Response('ok', { headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['content-type', 'text/plain']] });
        const copy = req.clone();
        console.log(JSON.stringify({
          cookie: req.headers.get('cookie'), referer: req.headers.get('referer'), origin: req.headers.get('origin'),
          cloned: copy.headers.get('cookie'), setCookie: res.headers.getSetCookie(), fromRequest: new Request(req).headers.get('cookie'),
          json: Response.json({ a: 1 }).headers.get('content-type'), isRequest: req instanceof Request,
        }));
        copy.text().then((t) => console.log('body', t));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const [json, body] = out.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(json), { cookie: 'a=1', referer: 'http://localhost/page', origin: 'http://localhost', cloned: 'a=1', setCookie: ['a=1', 'b=2'], fromRequest: 'a=1', json: 'application/json', isRequest: true });
  assert.equal(body, 'body hi');
});

test('worker_threads: a thread started while its parent is blocked runs (WebAssembly threads do this)', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { Worker } = require('worker_threads');
        const shared = new Int32Array(new SharedArrayBuffer(8));
        setTimeout(() => {
          // A browser cannot start a worker while its parent blocks; the thread comes from runtimes booted in advance,
          // and reads its files from the parent's snapshot while the parent does not answer.
          new Worker('const s = require("worker_threads").workerData; Atomics.store(s, 0, 42); Atomics.notify(s, 0);', { eval: true, workerData: shared });
          console.log('wait', Atomics.wait(shared, 0, 0, 10000), Atomics.load(shared, 0));
          process.exit(0);
        }, 1500);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), 'wait ok 42');
});

test('child_process: shell commands, npm scripts and package binaries run as Node programs', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { spawn, exec } = require('child_process');
        const c = spawn('npm run build --prefix server -- --fast && echo "done $GREETING" || echo failed', { shell: true, env: { ...process.env, GREETING: 'hi' } });
        let text = '';
        c.stdout.on('data', (d) => (text += d));
        c.on('exit', (code) => {
          console.log(JSON.stringify(text.trim().split('\\n')), code);
          exec('cd server && PORT=4001 greet one "two words"; missing-tool', (err, stdout, stderr) => {
            console.log(JSON.stringify(stdout.trim().split('\\n')), err && err.code, /missing-tool: not found/.test(stderr));
            process.exit(0);
          });
        });`,
      'server/package.json': JSON.stringify({ name: 'server', scripts: { prebuild: 'echo pre', build: 'greet built' } }),
      'server/node_modules/.sandburg-bins.json': JSON.stringify({ greet: 'node_modules/greeter/bin.js' }),
      'server/node_modules/greeter/bin.js': `console.log('greet ' + process.argv.slice(2).join('|') + ' port=' + (process.env.PORT ?? '-') + ' cwd=' + process.cwd());`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines[0], `${JSON.stringify(['pre', 'greet built|--fast port=- cwd=/app/server', 'done hi'])} 0`, out.stdout + out.stderr);
  assert.equal(lines[1], `${JSON.stringify(['greet one|two words port=4001 cwd=/app/server'])} 127 true`, out.stdout + out.stderr);
});

test('child_process: a program reaches a server another child process runs (a dev proxy and its API)', async () => {
  const out = await h.run(
    {
      'main.js': `require('child_process').spawn('node api.js & node web.js', { shell: true, stdio: 'inherit' });`,
      'api.js': `require('http').createServer((req, res) => res.end('api ' + req.method + ' ' + req.url)).listen(4200, () => console.log('api up'));`,
      'web.js': `
        const http = require('http');
        const ask = (port) => new Promise((resolve) => {
          http.get('http://localhost:' + port + '/items', (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve(body));
          }).on('error', (e) => resolve(e.code));
        });
        setTimeout(async () => console.log(await ask(4200), await ask(4299)), 300);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.match(out.stdout, /api GET \/items ECONNREFUSED/, out.stdout + out.stderr);
});

test('worker_threads: a blocked thread takes replies with receiveMessageOnPort (a synchronous call to the main thread)', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { Worker, MessageChannel } = require('worker_threads');
        const { port1, port2 } = new MessageChannel();
        const signal = new Int32Array(new SharedArrayBuffer(4));
        port1.on('message', (url) => {
          // Answered asynchronously, as Angular resolves a Sass import on its main thread.
          setTimeout(() => {
            port1.postMessage(url.startsWith('@') ? '/app/node_modules/' + url + '/_index.scss' : null);
            Atomics.store(signal, 0, 1);
            Atomics.notify(signal, 0);
          }, 10);
        });
        const w = new Worker(__dirname + '/thread.js', { workerData: { port: port2, signal }, transferList: [port2] });
        w.on('message', (m) => { console.log(JSON.stringify(m)); process.exit(0); });`,
      'thread.js': `
        const { workerData, parentPort, receiveMessageOnPort } = require('worker_threads');
        const { port, signal } = workerData;
        const ask = (url) => {
          Atomics.store(signal, 0, 0);
          port.postMessage(url);
          Atomics.wait(signal, 0, 0);
          return receiveMessageOnPort(port)?.message;
        };
        parentPort.postMessage([ask('@angular/material'), ask('./local'), receiveMessageOnPort(port)]);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), JSON.stringify(['/app/node_modules/@angular/material/_index.scss', null, null]), out.stderr);
});

test('child_process: a shell script ends with its foreground command, not with a background one that ends first', async () => {
  const out = await h.run(
    {
      'main.js': `
        const c = require('child_process').spawn('node seed.js & node server.js', { shell: true, stdio: 'inherit' });
        c.on('exit', (code) => console.log('script exited', code));`,
      'seed.js': `console.log('seeded');`,
      'server.js': `setTimeout(() => { console.log('server done'); process.exit(3); }, 300);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['seeded', 'server done', 'script exited 3']);
});

test('worker_threads: receiveMessageOnPort keeps working after more traffic than its mailbox holds', async () => {
  const out = await h.run(
    {
      'main.js': `
        const { Worker, MessageChannel } = require('worker_threads');
        const { port1, port2 } = new MessageChannel();
        const signal = new Int32Array(new SharedArrayBuffer(4));
        const big = 'x'.repeat(40 * 1024);
        port1.on('message', (n) => setTimeout(() => {
          port1.postMessage({ n, big });
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
        }, 1));
        const w = new Worker(__dirname + '/thread.js', { workerData: { port: port2, signal }, transferList: [port2] });
        w.on('message', (m) => { console.log(m); process.exit(0); });`,
      'thread.js': `
        const { workerData, parentPort, receiveMessageOnPort } = require('worker_threads');
        const { port, signal } = workerData;
        let ok = 0;
        for (let n = 0; n < 40; n++) {
          Atomics.store(signal, 0, 0);
          port.postMessage(n);
          Atomics.wait(signal, 0, 0);
          const reply = receiveMessageOnPort(port)?.message;
          if (reply && reply.n === n && reply.big.length === 40 * 1024) ok++;
        }
        parentPort.postMessage('replies ' + ok);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), 'replies 40', out.stderr);
});

test('zlib: gzip, deflate and raw deflate streams (native) interoperate with the synchronous functions', async () => {
  const out = await h.run(
    {
      'main.js': `
        const zlib = require('zlib');
        const { pipeline, Readable, Writable } = require('stream');
        const data = Buffer.from('sandburg '.repeat(2 * 1024 * 1024));
        const through = (stream, input) => new Promise((resolve, reject) => {
          const chunks = [];
          pipeline(Readable.from([input.subarray(0, 1000), input.subarray(1000)]), stream, new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }), (err) => (err ? reject(err) : resolve(Buffer.concat(chunks))));
        });
        (async () => {
          const t = performance.now();
          const gz = await through(zlib.createGzip(), data);
          const ms = performance.now() - t;
          const results = [
            zlib.gunzipSync(gz).equals(data),
            (await through(zlib.createGunzip(), zlib.gzipSync(data))).equals(data),
            zlib.inflateSync(await through(zlib.createDeflate(), data)).equals(data),
            zlib.inflateRawSync(await through(zlib.createDeflateRaw(), data)).equals(data),
            await new Promise((r) => zlib.gunzip(gz, (e, b) => r(!e && b.equals(data)))),
            await through(zlib.createGunzip(), Buffer.from('not gzip at all')).then(() => 'no error', (e) => e.code),
          ];
          console.log(JSON.stringify(results), gz.length < data.length / 100, ms < 2000);
        })();`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), `${JSON.stringify([true, true, true, true, true, 'Z_DATA_ERROR'])} true true`, out.stderr);
});

test('zlib: a flushed compressing stream emits what was written so far (compression middleware)', async () => {
  const out = await h.run(
    {
      'main.js': `
        const zlib = require('zlib');
        const results = [];
        const check = (make, inflate) => new Promise((resolve) => {
          const z = make();
          const chunks = [];
          z.on('data', (c) => chunks.push(c));
          z.write('event: tick\\ndata: 1\\n\\n');
          z.flush(() => {
            const sofar = inflate(Buffer.concat(chunks)).toString();
            z.end();
            resolve(sofar);
          });
        });
        (async () => {
          const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
          results.push(await check(() => zlib.createDeflateRaw(), (b) => zlib.inflateRawSync(b, opts)));
          // After gzip's 10-byte header, raw deflate.
          results.push(await check(() => zlib.createGzip(), (b) => zlib.inflateRawSync(b.subarray(10), opts)));
          console.log(JSON.stringify(results));
        })();`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout.trim(), JSON.stringify(['event: tick\ndata: 1\n\n', 'event: tick\ndata: 1\n\n']), out.stderr);
});

test('Buffer: UTF-8 conversions of long strings (native) match Node', async () => {
  const out = await h.run(
    {
      'main.js': `
        const s = 'héllo wörld 😀 '.repeat(20);
        const b = Buffer.from(s);
        const w = Buffer.alloc(10); const written = w.write('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀');
        const at = Buffer.alloc(300, 0x2e); const n = at.write(s, 5, 20, 'utf8');
        const bad = Buffer.concat([Buffer.from('x'.repeat(80)), Buffer.from([0xff, 0xfe, 0xc3])]);
        console.log(JSON.stringify([
          b.length, Buffer.byteLength(s), b.toString() === s, b.toString('utf8', 1, 3), b.toString(undefined, 0, 1000).length,
          written, w.subarray(0, written).toString(), n, at.subarray(0, 26).toString(),
          bad.toString().endsWith('\\ufffd\\ufffd\\ufffd'), Buffer.from('\\ufeff' + 'a'.repeat(70)).toString().charCodeAt(0),
        ]));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  // The values real Node 22 gives.
  assert.deepEqual(JSON.parse(out.stdout), [380, 380, true, 'é', 300, 8, '😀😀', 20, '.....héllo wörld 😀 h.', true, 0xfeff]);
});

test('fs: streamed and positional writes grow a file in place, as in Node', async () => {
  const out = await h.run(
    {
      'main.js': `
        const fs = require('fs');
        const fd = fs.openSync('/tmp/f.bin', 'w');
        fs.writeSync(fd, 'abcdef');
        fs.writeSync(fd, Buffer.from('XY'), 0, 2, 1); // an explicit position leaves the file position alone
        fs.writeSync(fd, 'gh');
        fs.closeSync(fd);
        const small = fs.readFileSync('/tmp/f.bin', 'utf8');
        const chunk = Buffer.alloc(64 * 1024, 7);
        const t = performance.now();
        const ws = fs.createWriteStream('/tmp/big.bin');
        for (let i = 0; i < 640; i++) ws.write(chunk);
        ws.end(() => {
          const big = fs.readFileSync('/tmp/big.bin');
          fs.appendFileSync('/tmp/big.bin', 'end');
          console.log(JSON.stringify([small, big.length, big.every((b) => b === 7), fs.statSync('/tmp/big.bin').size, performance.now() - t < 3000]));
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ['aXYdefgh', 640 * 64 * 1024, true, 640 * 64 * 1024 + 3, true]);
});
