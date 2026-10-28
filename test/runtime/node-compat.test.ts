/**
 * Node's behaviour where the runtime's own modules stood in for it differently: each program's
 * expected output is what Node 24 prints for it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

test('fs: open flags as open(2) has them, writeFile flags, read and write signatures, stream and watchFile events', async () => {
  const out = await h.run(
    {
      'main.js': `
        const fs = require('fs');
        const out = {};
        const f = '/app/f.txt';
        const read = () => fs.readFileSync(f, 'utf8');
        const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
        const { O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_WRONLY, O_APPEND } = fs.constants;
        out.rdwrMissing = code(() => fs.openSync(f, O_RDWR));
        fs.writeFileSync(f, 'abcdef');
        // O_RDWR without O_TRUNC (node:wasi's path_open) keeps what the file has.
        let fd = fs.openSync(f, O_RDWR);
        fs.writeSync(fd, 'XY');
        fs.closeSync(fd);
        out.rdwr = read();
        out.excl = code(() => fs.openSync(f, O_CREAT | O_EXCL | O_WRONLY));
        fd = fs.openSync(f, O_WRONLY | O_APPEND);
        fs.writeSync(fd, '+');
        fs.closeSync(fd);
        out.append = read();
        fs.closeSync(fs.openSync(f, 'r+'));
        out.rplus = read();
        fs.closeSync(fs.openSync(f, O_WRONLY | O_TRUNC));
        out.trunc = read();
        out.badFlag = code(() => fs.openSync(f, 'q'));
        fs.writeFileSync(f, 'abcdef');
        out.wx = code(() => fs.writeFileSync(f, 'new', { flag: 'wx' }));
        fs.writeFileSync(f, 'gh', { flag: 'a' });
        out.writeA = read();
        fs.writeFileSync(f, 'XY', { flag: 'r+' });
        out.writeRplus = read();
        out.writeRplusMissing = code(() => fs.writeFileSync(f + '.missing', 'x', { flag: 'r+' }));
        fd = fs.openSync(f, 'r');
        const b = Buffer.alloc(4);
        out.readSyncOpts = [fs.readSync(fd, b, { offset: 1, length: 2, position: 2 }), b.toString('latin1')];
        out.readSyncRange = code(() => fs.readSync(fd, b, 2, 3, 0));
        fs.read(fd, { buffer: Buffer.alloc(3), position: 1 }, (err, n, buf) => {
          out.readOpts = [err, n, buf.toString()];
          fs.read(fd, Buffer.alloc(5), { length: 2, position: 0 }, (err, n, buf) => {
            out.readBufOpts = [err, n, buf.toString('latin1')];
            fs.closeSync(fd);
            const wfd = fs.openSync(f, 'w');
            const data = Buffer.from('hello');
            fs.write(wfd, data, 0, 5, null, (err, n, buffer) => {
              out.writeBuf = [err, n, buffer === data];
              fs.write(wfd, ' str', (err, n, s) => {
                out.writeStr = [err, n, s];
                fs.closeSync(wfd);
                streams();
              });
            });
          });
        });
        function streams() {
          const events = [];
          const ws = fs.createWriteStream(f, { flags: 'a' });
          for (const e of ['open', 'ready', 'finish', 'close']) ws.on(e, (fd) => events.push(e === 'open' ? 'open ' + typeof fd : e));
          ws.end('!');
          ws.on('close', () => {
            const rs = fs.createReadStream(f, { encoding: 'utf8' });
            let text = '';
            for (const e of ['open', 'ready', 'end', 'close']) rs.on(e, (fd) => events.push(e === 'open' ? 'open ' + typeof fd : e));
            rs.on('data', (d) => (text += d));
            rs.on('close', () => {
              out.streams = [events, text];
              const missing = fs.createReadStream(f + '.missing');
              missing.on('open', () => events.push('missing open'));
              missing.on('error', (e) => {
                out.missingStream = e.code;
                watching();
              });
            });
          });
        }
        // Two listeners of one file: unwatchFile with a listener stops only that one.
        function watching() {
          const seen = [];
          const a = () => seen.push('a');
          const b = () => seen.push('b');
          fs.watchFile(f, { interval: 20 }, a);
          fs.watchFile(f, { interval: 20 }, b);
          const steps = [
            () => fs.writeFileSync(f, '1'),
            () => (fs.unwatchFile(f, a), fs.writeFileSync(f, '22')),
            () => (fs.unwatchFile(f), fs.writeFileSync(f, '333')),
            () => {
              out.watchFile = seen;
              console.log(JSON.stringify(out));
            },
          ];
          let i = 0;
          const next = () => {
            steps[i++]();
            if (i < steps.length) setTimeout(next, 100);
          };
          setTimeout(next, 100);
        }`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.exit, 0);
  assert.deepEqual(JSON.parse(out.stdout), {
    rdwrMissing: 'ENOENT',
    rdwr: 'XYcdef',
    excl: 'EEXIST',
    append: 'XYcdef+',
    rplus: 'XYcdef+',
    trunc: '',
    badFlag: 'ERR_INVALID_ARG_VALUE',
    wx: 'EEXIST',
    writeA: 'abcdefgh',
    writeRplus: 'XYcdefgh',
    writeRplusMissing: 'ENOENT',
    readSyncOpts: [2, '\u0000cd\u0000'],
    readSyncRange: 'ERR_OUT_OF_RANGE',
    readOpts: [null, 3, 'Ycd'],
    readBufOpts: [null, 2, 'XY\u0000\u0000\u0000'],
    writeBuf: [null, 5, true],
    writeStr: [null, 4, ' str'],
    streams: [['open number', 'ready', 'finish', 'close', 'open number', 'ready', 'end', 'close'], 'hello str!'],
    missingStream: 'ENOENT',
    watchFile: ['a', 'b', 'b'],
  });
});

test('fs: a write stream renamed as the gzip stream piped into it finishes keeps all it was sent (webpack\'s cache packs)', async () => {
  const out = await h.run(
    {
      'main.js': `
        const fs = require('fs');
        const zlib = require('zlib');
        const f = '/app/index.pack.gz';
        const gz = zlib.createGzip();
        const ws = fs.createWriteStream(f + '_');
        gz.pipe(ws);
        gz.on('finish', () => fs.renameSync(f + '_', f));
        ws.on('close', () => setTimeout(() => console.log(JSON.stringify([zlib.gunzipSync(fs.readFileSync(f)).toString().length, fs.existsSync(f + '_')])), 50));
        for (let i = 0; i < 64; i++) gz.write(Buffer.alloc(16384, i));
        gz.end('packed');`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), [64 * 16384 + 'packed'.length, false]);
});

test('timers: a throwing immediate leaves the rest of its batch to run; a timeout refreshed after it fired keeps the process alive', async () => {
  const out = await h.run(
    {
      'main.js': `
        const out = [];
        process.on('uncaughtException', (e) => out.push('caught ' + e.message));
        setImmediate(() => {
          out.push('a');
          setImmediate(() => out.push('d'));
        });
        setImmediate(() => {
          throw new Error('b');
        });
        setImmediate(() => out.push('c'));
        setTimeout(() => console.log(JSON.stringify(out)), 100);
        // Longer apart than the runtime waits on an idle event loop before the process ends.
        let n = 0;
        const t = setTimeout(() => {
          console.log('fired', ++n);
          if (n === 1) t.refresh();
        }, 400);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['["a","caught b","c","d"]', 'fired 1', 'fired 2']);
  assert.equal(out.exit, 0);
});

test("process.exit in an 'exit' listener ends the process with its code, and 'exit' sees process.exitCode", async () => {
  const out = await h.run(
    {
      'main.js': `
        process.on('exit', (code) => {
          console.log('exit', code, process.exitCode);
          process.exit(5);
        });
        process.on('exit', () => console.log('not reached'));
        process.exit(3);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'exit 3 3\n');
  assert.equal(out.exit, 5);
});

test('process.exit(undefined) exits 0 whatever exitCode was; an integer string is the exit code', async () => {
  const codes = [];
  for (const program of ['process.exitCode = 4; process.exit(undefined);', "process.exitCode = '2'; console.log(typeof process.exitCode);", "process.exit('3');"]) {
    const out = await h.run({ 'main.js': program }, '/app/main.js');
    assert.equal(out.fatal, null, out.fatal ?? out.stderr);
    codes.push([out.exit, out.stdout]);
  }
  assert.deepEqual(codes, [[0, ''], [2, 'number\n'], [3, '']]);
});

test("http: a request in flight to a child process's server is answered after its parent exits", async () => {
  const out = await h.run(
    {
      'main.js': `
        const child = require('child_process').fork(require('path').join(__dirname, 'child.js'));
        child.on('message', (m) => m === 'asked' && process.exit(0));`,
      'child.js': `
        require('http').createServer((req, res) => {
          process.send('asked');
          setTimeout(() => res.end('from the child'), 300);
        }).listen(3001);`,
    },
    '/app/main.js',
    [{ url: '/' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.responses.map((r) => [r.status, r.body]), [[200, 'from the child']]);
});

test("http: a request in flight to the program's own server gets an error when it exits", { timeout: 30_000 }, async () => {
  const out = await h.run(
    { 'main.js': `require('http').createServer(() => setTimeout(() => process.exit(0), 50)).listen(3000);` },
    '/app/main.js',
    [{ url: '/' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.responses.map((r) => [r.status, r.body]), [[0, 'the process exited with code 0']]);
});

test("http: a child process that exits with a request in flight answers it itself, before its parent learns it is gone", { timeout: 30_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `require('child_process').fork(require('path').join(__dirname, 'child.js'));`,
      'child.js': `require('http').createServer(() => setTimeout(() => process.exit(0), 50)).listen(3001);`,
    },
    '/app/main.js',
    [{ url: '/' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  // The child's own answer (it exited), not its parent's for a child that is gone ('socket hang up').
  assert.deepEqual(out.responses.map((r) => [r.status, r.body]), [[0, 'the process exited with code 0']]);
});

/** How many messages ended each request, from a run's `ends`. */
const endsPerRequest = (ends: [string, number][]) => {
  const count = new Map<number, number>();
  for (const [type, id] of ends) if (type !== 'exit') count.set(id, (count.get(id) ?? 0) + 1);
  return Object.fromEntries(count);
};

test('http: requests in flight to a child process that exits are answered once each', { timeout: 30_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `require('child_process').fork(require('path').join(__dirname, 'child.js'));`,
      'child.js': `let n = 0; require('http').createServer(() => ++n === 2 && setTimeout(() => process.exit(0), 20)).listen(3001);`,
    },
    '/app/main.js',
    [{ url: '/a' }, { url: '/b' }],
    undefined,
    // Long after the child's runtime has ended (forgetNested), which answers what is still open.
    { linger: 500 },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(endsPerRequest(out.ends), { 0: 1, 1: 1 }, JSON.stringify(out.ends));
  assert.deepEqual(out.responses.map((r) => r.body), ['the process exited with code 0', 'the process exited with code 0']);
});

test("http: a response a handler writes after its process exited is not sent", { timeout: 30_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `
        require('http').createServer((req, res) => setTimeout(() => {
          // Runs once process.exit() has ended the process (after the timer's task).
          Promise.resolve().then(() => res.end('late'));
          process.exit(0);
        }, 10)).listen(3000);`,
    },
    '/app/main.js',
    [{ url: '/' }],
    undefined,
    { linger: 300 },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  // The late write ('late', a response-full) is not sent: the request's only answer is the error.
  assert.deepEqual(out.ends.filter(([type]) => type !== 'exit'), [['response-error', 0]]);
  assert.deepEqual(out.ends.filter(([type]) => type === 'exit'), [['exit', 0]]);
});

test('http: process.exit() in a request handler ends the process with its code', { timeout: 30_000 }, async () => {
  const out = await h.run({ 'main.js': `require('http').createServer(() => process.exit(7)).listen(3000);` }, '/app/main.js', [{ url: '/' }], undefined, { linger: 300 });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.ends, [['response-error', 0], ['exit', 7]]);
  assert.equal(out.responses[0].body, 'the process exited with code 7');
});

test('process.exit() ends the process once: nothing it scheduled runs after, and it exits once', async () => {
  // Not again as a callback queued before it runs, or once its event loop is found idle.
  const once = await h.run({ 'main.js': `Promise.resolve().then(() => process.exit(4)); process.exit(3);` }, '/app/main.js', [], undefined, { linger: 500 });
  assert.deepEqual(once.ends, [['exit', 3]]);
  const ticks = await h.run(
    {
      'main.js': `
        setInterval(() => console.log('tick'), 5);
        setImmediate(() => setTimeout(() => process.exit(0), 30));
        process.on('exit', () => console.log('exit'));`,
    },
    '/app/main.js',
    [],
    undefined,
    { linger: 300 },
  );
  assert.equal(ticks.fatal, null, ticks.fatal ?? ticks.stderr);
  assert.equal(ticks.stdout.trim().split('\n').at(-1), 'exit', ticks.stdout);
  assert.deepEqual(ticks.ends, [['exit', 0]]);
});

test("http: process.exit() in a handler of a child process's request ends the process; the child's request fails", async () => {
  const out = await h.run(
    {
      'main.js': `
        process.on('exit', (code) => console.log('parent exit', code));
        require('http').createServer(() => process.exit(5)).listen(3000, () => require('child_process').fork(require('path').join(__dirname, 'child.js'), { stdio: 'inherit' }));`,
      'child.js': `require('http').get('http://localhost:3000/', () => console.log('answered')).on('error', (e) => console.log('child got', e.code, e.message));`,
    },
    '/app/main.js',
    [],
    undefined,
    // The child, a process of its own, reports after its parent exited: the run is kept until it has.
    { linger: 10_000, until: ({ stdout }) => stdout.includes('child got') },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.ends, [['exit', 5]]);
  assert.deepEqual(out.stdout.trim().split('\n'), ['parent exit 5', 'child got ECONNRESET socket hang up']);
});

test("http: a child process's request is reset when its parent's handler destroys the response, and answered when it ends it", async () => {
  const out = await h.run(
    {
      'main.js': `
        const serving = globalThis[Symbol.for('sandburg.servingLoopback')];
        require('http').createServer((req, res) => {
          if (req.url === '/destroy') res.destroy();
          else if (req.url === '/socket') {
            res.writeHead(200);
            res.write('part');
            setTimeout(() => req.socket.destroy(), 10);
          } else if (req.url === '/end-then-close') {
            res.write('all ');
            res.end('sent');
            req.socket.destroy();
          } else res.end('whole');
        }).listen(3000, () => {
          const child = require('child_process').fork(require('path').join(__dirname, 'child.js'));
          child.on('message', (m) => {
            console.log(m);
            if (m === 'done') setTimeout(() => console.log('serving', serving()), 50);
          });
        });`,
      'child.js': `
        const http = require('http');
        const get = (path) => new Promise((resolve) => {
          const log = [path];
          http.get('http://localhost:3000' + path, (res) => {
            log.push(res.statusCode);
            // The body whole, however it was cut in chunks.
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('aborted', () => log.push(body, 'aborted'));
            res.on('error', (e) => log.push('res error ' + e.code));
            res.on('end', () => log.push(body, 'end'));
            res.on('close', () => resolve(log.join(' ')));
          }).on('error', (e) => resolve(log.concat('error', e.code, e.message).join(' ')));
        });
        (async () => {
          for (const path of ['/destroy', '/socket', '/end-then-close', '/ok']) process.send(await get(path));
          process.send('done');
        })();`,
    },
    '/app/main.js',
    [],
    undefined,
    { linger: 10_000, until: ({ stdout }) => stdout.includes('serving') },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), [
    '/destroy error ECONNRESET socket hang up',
    '/socket 200 part aborted res error ECONNRESET',
    '/end-then-close 200 all sent end',
    '/ok 200 whole end',
    'done',
    // What the parent's servers answer for its child is answered, and forgotten.
    'serving 0',
  ]);
});

/**
 * A server whose client, a child process, is killed (/killed) or exits (/exits) mid-request; with
 * `read`, once the handler has read the request to its end. Node 24 prints what the tests expect.
 */
const dyingClient = (read: boolean) => `
  const serving = globalThis[Symbol.for('sandburg.servingLoopback')] ?? (() => 0);
  const { fork } = require('child_process');
  const path = require('path');
  let child;
  require('http').createServer((req, res) => {
    const log = [req.url];
    req.on('aborted', () => log.push('aborted ' + req.aborted));
    req.on('error', (e) => log.push('req error ' + e.code + ' ' + e.message));
    req.on('end', () => log.push('end'));
    req.on('close', () => log.push('req close'));
    res.on('close', () => {
      log.push('res close');
      setTimeout(() => {
        console.log(log.join(', ') + ' | serving ' + serving());
        // The child that exits on its own next.
        if (req.url === '/killed') child = fork(path.join(__dirname, 'child.js'), ['/exits']);
        else process.exit(0);
      }, 50);
    });
    const go = () => (req.url === '/killed' ? child.kill() : child.send('exit'));
    if (${read}) {
      req.resume();
      req.on('end', () => setTimeout(go, 20));
    } else go();
  }).listen(3000, () => (child = fork(path.join(__dirname, 'child.js'), ['/killed'])));`;

const dyingChild = `
  process.on('message', () => process.exit(0));
  require('http').get('http://localhost:3000' + process.argv[2], () => console.log('answered'));`;

test("http: a child process that dies mid-request aborts its request in the parent's server, in Node's order", async () => {
  const out = await h.run({ 'main.js': dyingClient(false), 'child.js': dyingChild }, '/app/main.js', [], undefined, { linger: 10_000, until: ({ stdout }) => stdout.split('serving').length === 3 });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), [
    '/killed, aborted true, res close, req error ECONNRESET aborted, req close | serving 0',
    '/exits, aborted true, res close, req error ECONNRESET aborted, req close | serving 0',
  ]);
});

test('http: a request read to its end is not aborted when its client then dies; its response closes', async () => {
  const out = await h.run({ 'main.js': dyingClient(true), 'child.js': dyingChild }, '/app/main.js', [], undefined, { linger: 10_000, until: ({ stdout }) => stdout.split('serving').length === 3 });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['/killed, end, req close, res close | serving 0', '/exits, end, req close, res close | serving 0']);
});

test("http: res.destroy(err) goes to the server's 'clientError', not to the response's 'error'", async () => {
  const out = await h.run(
    {
      'main.js': `
        const s = require('http').createServer((req, res) => {
          const log = [];
          res.on('error', (e) => log.push('res error ' + e.message));
          res.on('close', () => {
            log.push('res close');
            setTimeout(() => {
              console.log(log.join(', '));
              process.exit(0);
            }, 50);
          });
          s.on('clientError', (e) => log.push('clientError ' + e.message));
          res.destroy(new Error('x'));
        }).listen(3001, () => require('http').get('http://localhost:3001/').on('error', () => {}));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'clientError x, res close\n');
});

test('http: res.destroy() for a client in the same process closes the connection, then fails the request', async () => {
  const out = await h.run(
    {
      'main.js': `
        const log = [];
        require('http').createServer((req, res) => {
          req.on('close', () => log.push('req close'));
          res.on('close', () => log.push('res close'));
          res.on('error', (e) => log.push('res error ' + e.message));
          res.destroy();
          log.push('socket destroyed ' + req.socket.destroyed);
        }).listen(3002, () => require('http').get('http://localhost:3002/').on('error', (e) => {
          log.push('client error ' + e.code + ' ' + e.message);
          setTimeout(() => {
            console.log(log.join(', '));
            process.exit(0);
          }, 50);
        }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'socket destroyed true, res close, req close, client error ECONNRESET socket hang up\n');
});

test('http: a response its handler destroys is reset, not left waiting', { timeout: 30_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `
        require('http').createServer((req, res) => {
          if (req.url === '/destroy') return res.destroy();
          res.writeHead(200);
          res.write('part');
          setTimeout(() => res.destroy(), 10);
        }).listen(3000);`,
    },
    '/app/main.js',
    [{ url: '/destroy' }, { url: '/part' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.ends, [['response-error', 0], ['response-error', 1]]);
  assert.deepEqual(out.responses.map((r) => [r.status, r.body]), [[0, 'socket hang up'], [200, 'part']]);
});

test('timers: nothing set after process.exit(), or in an exit listener, runs', async () => {
  const out = await h.run(
    {
      'main.js': `
        process.on('exit', () => setTimeout(() => console.log('timer in exit listener'), 0));
        setTimeout(() => {
          Promise.resolve().then(() => {
            setTimeout(() => console.log('timeout'), 0);
            setImmediate(() => console.log('immediate'));
            setInterval(() => console.log('interval'), 5);
          });
          process.exit(0);
        }, 10);`,
    },
    '/app/main.js',
    [],
    undefined,
    { linger: 300 },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, '');
  assert.deepEqual(out.ends, [['exit', 0]]);
});

test('WebSockets: an open connection closes (1006) when its process exits', async () => {
  const server = `
    const crypto = require('crypto');
    const server = require('http').createServer();
    server.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
      setTimeout(() => process.exit(0), 20);
    });
    server.listen(3000);`;
  const out = await h.runWebSocket({ 'main.js': server }, '/app/main.js', '/', [], []);
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.events, [['open', ''], ['closed', 1006, '', false], ['exit', 0]]);
});

test('net: a socket ends its side once the peer ends, unless allowHalfOpen; then both close and the process ends', async () => {
  const out = await h.run(
    {
      'main.js': `
        const net = require('net');
        const log = [];
        // Both sides closed (in no set order): the next connection.
        let open = 2;
        const closed = (who) => {
          log.push(who + ' close');
          if (--open === 0) (log.sort(), plain.close(), halfOpen());
        };
        const plain = net.createServer((s) => {
          s.on('data', (d) => s.write('echo:' + d));
          s.on('end', () => log.push('server end, writable ' + s.writable));
          s.on('close', () => closed('server'));
        });
        plain.listen(0, '127.0.0.1', () => {
          const c = net.connect(plain.address().port, '127.0.0.1', () => c.end('hi'));
          c.on('data', (d) => log.push('client got ' + d));
          c.on('close', () => closed('client'));
        });
        function halfOpen() {
          const server = net.createServer({ allowHalfOpen: true }, (s) => {
            s.on('end', () => {
              log.push('half-open end, writable ' + s.writable);
              s.end('late');
            });
            s.on('close', () => server.close());
          });
          server.listen(0, '127.0.0.1', () => {
            const c = net.connect(server.address().port, '127.0.0.1', () => c.end());
            c.on('data', (d) => log.push('client got ' + d));
            c.on('close', () => console.log(JSON.stringify(log)));
          });
        }`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ['client close', 'client got echo:hi', 'server close', 'server end, writable true', 'half-open end, writable true', 'client got late']);
  assert.equal(out.exit, 0, 'nothing left open');
});

test('child_process: a shell command killed exits with its signal, not the shell\'s code', async () => {
  const out = await h.run(
    {
      'main.js': `
        const c = require('child_process').spawn('node forever.js', { shell: true });
        c.stdout.once('data', () => c.kill());
        c.on('exit', (code, signal) => console.log('exit', JSON.stringify([code, signal, c.killed, c.exitCode, c.signalCode])));`,
      'forever.js': `setInterval(() => {}, 1000); console.log('started');`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'exit [null,"SIGTERM",true,null,"SIGTERM"]\n');
});
