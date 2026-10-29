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
        }).listen(3002, () => {
          const c = require('http').get('http://localhost:3002/');
          c.on('error', (e) => log.push('client error ' + e.code + ' ' + e.message));
          c.on('close', () => {
            log.push('client close destroyed=' + c.destroyed);
            setTimeout(() => {
              console.log(log.join(', '));
              process.exit(0);
            }, 50);
          });
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'socket destroyed true, res close, req close, client error ECONNRESET socket hang up, client close destroyed=true\n');
});

test("http: process.exit() in a request's 'aborted' listener ends the process when its client, a child process, dies", async () => {
  const out = await h.run(
    {
      'main.js': `
        const { fork } = require('child_process');
        let child;
        require('http').createServer((req, res) => {
          req.on('aborted', () => {
            console.log('aborted');
            process.exit(3);
          });
          req.on('error', (e) => console.log('req error ' + e.message));
          res.on('close', () => console.log('res close'));
          child.kill();
        }).listen(3000, () => (child = fork(__dirname + '/child.js')));
        setTimeout(() => console.log('still alive'), 2000);`,
      'child.js': `require('http').get('http://localhost:3000/', () => {});`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual([out.stdout, out.exit], ['aborted\n', 3]);
});

test("http: process.exit() in an 'aborted', 'close' or 'clientError' listener of a response destroyed for the same process ends it", async () => {
  const exits = [];
  for (const [listener, destroy] of [
    [`req.on('aborted', () => { console.log('aborted'); process.exit(5); })`, 'res.destroy()'],
    [`res.on('close', () => { console.log('res close'); process.exit(6); })`, 'res.destroy()'],
    [`req.on('close', () => { console.log('req close'); process.exit(7); })`, 'res.destroy()'],
    [`s.on('clientError', () => { console.log('clientError'); process.exit(8); })`, "res.destroy(new Error('x'))"],
  ]) {
    const out = await h.run(
      {
        'main.js': `
          const s = require('http').createServer((req, res) => {
            // Handled: the exit is not an unhandled 'error' that would end the process anyway.
            req.on('error', (e) => console.log('req error ' + e.message));
            res.on('error', (e) => console.log('res error ' + e.message));
            ${listener};
            ${destroy};
          }).listen(3001, () => require('http').get('http://localhost:3001/').on('error', () => console.log('client error')));
          setTimeout(() => console.log('still alive'), 1000);`,
      },
      '/app/main.js',
    );
    assert.equal(out.fatal, null, out.fatal ?? out.stderr);
    exits.push([out.stdout, out.exit]);
  }
  assert.deepEqual(exits, [['aborted\n', 5], ['res close\n', 6], ['req error aborted\nreq close\n', 7], ['clientError\n', 8]]);
});

test('http: req.destroy() in a handler closes the connection: the client gets ECONNRESET', async () => {
  const out = await h.run(
    {
      'main.js': `
        const log = [];
        require('http').createServer((req, res) => {
          req.on('aborted', () => log.push('req aborted'));
          req.on('close', () => log.push('req close'));
          res.on('close', () => log.push('res close'));
          req.destroy();
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
  assert.equal(out.stdout, 'req aborted, socket destroyed true, req close, res close, client error ECONNRESET socket hang up\n');
});

test("http: res.destroy(err) once the response ended still goes to 'clientError'; the client has the response", async () => {
  const out = await h.run(
    {
      'main.js': `
        // The server's side and the client's (which here has its response as it ends, before the destroy).
        const log = [];
        const client = [];
        const done = () => setTimeout(() => {
          console.log(log.join(', '));
          console.log(client.join(', '));
          process.exit(0);
        }, 50);
        const s = require('http').createServer((req, res) => {
          s.on('clientError', (e) => log.push('clientError ' + e.message));
          res.on('close', () => log.push('res close'));
          res.on('error', (e) => log.push('res error ' + e.message));
          res.end('x');
          res.destroy(new Error('boom'));
        }).listen(3003, () => {
          require('http').get('http://localhost:3003/', (res) => {
            client.push('client ' + res.statusCode);
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('aborted', () => client.push('client aborted'));
            res.on('error', (e) => client.push('client res error ' + e.code));
            res.on('end', () => client.push('client body ' + body));
            res.on('close', () => {
              client.push('client close');
              done();
            });
          }).on('error', (e) => {
            client.push('client error ' + e.code + ' ' + e.message);
            done();
          });
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'clientError boom, res close\nclient 200, client body x, client close\n');
});

test("http: a response that came through fetch() and was read to its end is complete, not 'aborted'", async () => {
  const out = await h.run(
    {
      'main.js': `
        // Another origin's (not this machine's servers: through fetch()), the harness's.
        require('http').get(process.env.REMOTE, (res) => {
          const log = [];
          res.on('aborted', () => log.push('aborted'));
          res.on('data', (d) => log.push('data ' + d));
          res.on('end', () => log.push('end'));
          res.on('close', () => {
            log.push('close', 'aborted ' + res.aborted, 'complete ' + res.complete);
            console.log(log.join(', '));
          });
        });`,
    },
    '/app/main.js',
    [],
    undefined,
    { env: { REMOTE: `http://fetch.localhost:${h.port}/__test/remote` } },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'data remote, end, close, aborted false, complete true\n');
});

test('http: a request ended after it has its socket goes out once, to another origin (through fetch()) and to a server of its own', async () => {
  const out = await h.run(
    {
      'main.js': `
        // Ended in its 'socket' listener, a tick after it, or with a body after it (a POST), or a GET 20 ms
        // after: one request each, as in Node.
        const http = require('http');
        const counted = new Map();
        http.createServer((req, res) => {
          const key = new URL(req.url, 'http://x').searchParams.get('key');
          if (new URL(req.url, 'http://x').searchParams.get('read') === '1') return res.end(String(counted.get(key) ?? 0));
          counted.set(key, (counted.get(key) ?? 0) + 1);
          req.resume();
          req.on('end', () => res.end('counted'));
        }).listen(3019, () => run());
        const cases = {
          'end() on socket': (req) => req.on('socket', () => req.end()),
          'end() a tick after socket': (req) => req.on('socket', () => setTimeout(() => req.end(), 0)),
          'end(body) after socket': (req) => req.on('socket', () => setTimeout(() => req.end('body'), 0)),
          'GET end() 20 ms after socket': (req) => req.on('socket', () => setTimeout(() => req.end(), 20)),
        };
        const key = (name) => encodeURIComponent(name);
        const run = async () => {
          const lines = [];
          for (const [where, base] of [['remote', process.env.REMOTE], ['own', 'http://localhost:3019/']]) {
          for (const [name, act] of Object.entries(cases)) await new Promise((done) => {
            const req = http.request(base + '?key=' + key(name), { method: name.startsWith('GET') ? 'GET' : 'POST' }, (res) => { res.resume(); res.on('end', done); });
            req.on('error', (e) => { console.log(name + ': error ' + e.message); done(); });
            act(req);
          });
          for (const name of Object.keys(cases)) lines.push(where + ', ' + name + ': ' + await new Promise((done) => http.get(base + '?read=1&key=' + key(name), (res) => {
            let b = '';
            res.on('data', (d) => (b += d));
            res.on('end', () => done(b));
          })));
          }
          console.log(lines.join('\\n'));
          process.exit(0);
        };`,
    },
    '/app/main.js',
    [],
    undefined,
    { env: { REMOTE: `http://fetch.localhost:${h.port}/__test/count` } },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['remote', 'own'].flatMap((where) => ['end() on socket', 'end() a tick after socket', 'end(body) after socket', 'GET end() 20 ms after socket'].map((name) => `${where}, ${name}: 1`)));
});

/**
 * A program's requests to a server of its own (3005: through the runtime) and, with REMOTE, to another
 * origin's (through fetch()): /ok answers, /hold starts a response and never ends it. Logs each case on a line.
 */
const clientCases = (cases: string) => `
  const http = require('http');
  const local = 'http://localhost:3005';
  const remote = process.env.REMOTE;
  const lines = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/hold') {
      res.writeHead(200);
      res.write('a');
    } else res.end('ok');
  }).listen(3005, async () => {
    const steps = [${cases}];
    for (const step of steps) lines.push(await new Promise((resolve) => step(resolve)));
    console.log(lines.join('\\n'));
    process.exit(0);
  });`;

test('http: a request closes (destroyed) once its response ended, or once it failed, as in Node', async () => {
  const out = await h.run(
    {
      'main.js': clientCases(`
        ...[local + '/ok', remote + '/__test/remote'].map((url) => (done) => {
          const log = [];
          const req = http.get(url, (res) => {
            res.resume();
            res.on('end', () => log.push('res end destroyed=' + req.destroyed));
            res.on('close', () => log.push('res close'));
          });
          req.on('close', () => {
            log.push('req close');
            setTimeout(() => done(log.join(' | ')), 20);
          });
        }),
        (done) => {
          const log = [];
          const req = http.get('http://fetch.localhost:1/');
          req.on('error', (e) => log.push('req error ' + e.code));
          req.on('close', () => {
            log.push('req close destroyed=' + req.destroyed);
            setTimeout(() => done(log.join(' | ')), 20);
          });
        },`),
    },
    '/app/main.js',
    [],
    undefined,
    { env: { REMOTE: `http://fetch.localhost:${h.port}` } },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['res end destroyed=true | req close | res close', 'res end destroyed=true | req close | res close', 'req error ECONNREFUSED | req close destroyed=true']);
});

test('http: destroying a request whose response is in flight aborts the response; destroying the response closes the request', async () => {
  const out = await h.run(
    {
      'main.js': clientCases(`
        ...[local + '/hold', remote + '/__test/hold'].flatMap((url) => ['req', 'res'].map((which) => (done) => {
          const log = [];
          const req = http.get(url, (res) => {
            log.push('response');
            res.on('aborted', () => log.push('res aborted'));
            res.on('error', (e) => log.push('res error ' + e.code));
            res.on('close', () => log.push('res close destroyed=' + req.destroyed));
            (which === 'req' ? req : res).destroy();
          });
          req.on('error', (e) => log.push('req error ' + e.code + ' ' + e.message));
          req.on('close', () => log.push('req close'));
          setTimeout(() => done(log.join(' | ')), 200);
        })),
        // Destroyed before its response: it failed ("socket hang up").
        ...[local + '/ok', remote + '/__test/remote'].map((url) => (done) => {
          const log = [];
          const req = http.get(url, () => log.push('response'));
          req.on('error', (e) => log.push('req error ' + e.code + ' ' + e.message));
          req.on('close', () => log.push('req close destroyed=' + req.destroyed));
          req.destroy();
          setTimeout(() => done(log.join(' | ')), 200);
        }),
        // The other origin saw both of its connections close, while this program still runs (it
        // answers once it has, or after 10 s): not as the run ended and took its fetches with it.
        (done) => http.get(remote + '/__test/hold-closed?count=2', (res) => {
          let count = '';
          res.on('data', (d) => (count += d));
          res.on('end', () => done('hold closed: ' + count));
        }),`),
    },
    '/app/main.js',
    [],
    undefined,
    { env: { REMOTE: `http://fetch.localhost:${h.port}` } },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const inFlight = ['response | res aborted | req close | res error ECONNRESET | res close destroyed=true', 'response | res aborted | res close destroyed=false | req close'];
  const before = 'req error ECONNRESET socket hang up | req close destroyed=true';
  assert.deepEqual(out.stdout.trim().split('\n'), [...inFlight, ...inFlight, before, before, 'hold closed: 2']);
  // What was still coming from the other origin is not read: its two responses' connections closed.
  assert.deepEqual(h.asked.filter((a) => a === 'hold closed'), ['hold closed', 'hold closed']);
});

test("http: what an 'aborted' listener throws is the request's error; the process goes on", async () => {
  const out = await h.run(
    {
      'main.js': `
        const s = require('http').createServer((req, res) => {
          req.on('aborted', () => {
            console.log('aborted');
            throw new Error('boom');
          });
          req.on('error', (e) => console.log('req error ' + e.message));
          res.destroy();
        }).listen(3006, () => require('http').get('http://localhost:3006/').on('error', () => {}));
        setTimeout(() => {
          console.log('still alive');
          process.exit(0);
        }, 300);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual([out.stdout, out.exit], ['aborted\nreq error boom\nstill alive\n', 0]);
});

test("http: 'clientError' comes after res.destroy(err) returns; what its listener throws is uncaught, not the handler's", async () => {
  const out = await h.run(
    {
      'main.js': `
        process.on('uncaughtException', (e) => console.log('uncaught ' + e.message));
        const s = require('http').createServer((req, res) => {
          s.on('clientError', (e) => {
            console.log('clientError ' + e.message);
            throw new Error('thrown');
          });
          try {
            res.destroy(new Error('x'));
            console.log('after destroy');
          } catch (e) {
            console.log('caught in handler ' + e.message);
          }
        }).listen(3007, () => require('http').get('http://localhost:3007/').on('error', () => {}));
        setTimeout(() => process.exit(0), 300);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'after destroy\nclientError x\nuncaught thrown\n');
});

test('http: req.abort() destroys the request (no error) and emits \'abort\'; with a response in flight, that is aborted', async () => {
  const out = await h.run({ 'main.js': `
        // req.abort() before a response, and with one in flight; to a server of this program's and (REMOTE) another origin's.
        const http = require('http');
        const lines = [];
        http.createServer((req, res) => {
          if (req.url === '/hold') {
            res.writeHead(200);
            res.write('a');
          } else res.end('ok');
        }).listen(3010, async () => {
          for (const [ok, hold] of [['http://localhost:3010/ok', 'http://localhost:3010/hold'], [process.env.REMOTE + '/__test/remote', process.env.REMOTE + '/__test/hold']]) {
            lines.push(await new Promise((done) => {
              const log = [];
              const req = http.get(ok, () => log.push('response'));
              req.on('abort', () => log.push('abort'));
              req.on('error', (e) => log.push('error ' + e.code));
              req.on('close', () => log.push('close destroyed=' + req.destroyed));
              req.abort();
              setTimeout(() => done(log.join(',')), 200);
            }));
            lines.push(await new Promise((done) => {
              const log = [];
              const req = http.get(hold, (res) => {
                log.push('response');
                res.on('aborted', () => log.push('res aborted'));
                res.on('error', (e) => log.push('res error ' + e.code));
                res.on('close', () => log.push('res close'));
                req.abort();
              });
              req.on('abort', () => log.push('abort'));
              req.on('error', (e) => log.push('error ' + e.code));
              req.on('close', () => log.push('close'));
              setTimeout(() => done(log.join(',')), 200);
            }));
          }
          console.log(lines.join('\\n'));
          process.exit(0);
        });` }, '/app/main.js', [], undefined, { env: { REMOTE: `http://fetch.localhost:${h.port}` } });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const before = 'close destroyed=true,abort';
  const inFlight = 'response,abort,res aborted,close,res error ECONNRESET,res close';
  assert.deepEqual(out.stdout.trim().split('\n'), [before, inFlight, before, inFlight]);
});

test('http: a server learns its client went away: the request destroyed or aborted, or its response destroyed, before or after a response', async () => {
  const out = await h.run({ 'main.js': `
        // The server learns its client went away: the request destroyed or aborted, or its response destroyed; or the request destroyed before any response.
        const http = require('http');
        const lines = [];
        let log;
        http.createServer((req, res) => {
          log.push('server request');
          req.on('aborted', () => log.push('server aborted'));
          req.on('close', () => log.push('server req close'));
          res.on('close', () => log.push('server res close'));
          if (req.url === '/silent') return;
          res.writeHead(200);
          res.write('a');
        }).listen(3011, async () => {
          for (const how of ['req.destroy', 'res.destroy', 'req.abort']) {
            log = [];
            await new Promise((done) => {
              const req = http.get('http://localhost:3011/', (res) => {
                res.on('error', () => {});
                setTimeout(() => (how === 'res.destroy' ? res.destroy() : how === 'req.destroy' ? req.destroy() : req.abort()), 20);
              });
              req.on('error', () => {});
              setTimeout(done, 200);
            });
            lines.push(how + ': ' + log.join(','));
          }
          // Destroyed before any response.
          log = [];
          await new Promise((done) => {
            const req = http.get('http://localhost:3011/silent');
            req.on('error', () => {});
            setTimeout(() => req.destroy(), 20);
            setTimeout(done, 200);
          });
          lines.push('before a response: ' + log.join(','));
          console.log(lines.join('\\n'));
          process.exit(0);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const events = 'server request,server aborted,server res close,server req close';
  assert.deepEqual(out.stdout.trim().split('\n'), [`req.destroy: ${events}`, `res.destroy: ${events}`, `req.abort: ${events}`, `before a response: ${events}`]);
});

test("http: a server in another process (a child's, its parent's) learns its client went away", async () => {
  const out = await h.run(
    {
      'main.js': `
        const http = require('http');
        const { fork } = require('child_process');
        const lines = [];
        const log = [];
        http.createServer((req, res) => {
          log.push('server request');
          req.on('aborted', () => log.push('server aborted'));
          req.on('close', () => log.push('server req close'));
          res.on('close', () => log.push('server res close'));
          res.writeHead(200);
          res.write('a');
        }).listen(3020, () => {
          const child = fork(__dirname + '/child.js');
          child.on('message', (m) => {
            if (m === 'listening') {
              // To the child's server, which learns this client went away.
              const req = http.get('http://localhost:3021/', (res) => {
                res.on('error', () => {});
                setTimeout(() => req.destroy(), 20);
              });
              req.on('error', () => {});
            } else if (m.child) {
              lines.push('child server: ' + m.child);
              child.send('client');
            } else if (m === 'client done') {
              setTimeout(() => {
                lines.push('parent server: ' + log.join(','));
                console.log(lines.join('\\n'));
                process.exit(0);
              }, 200);
            }
          });
        });`,
      'child.js': `
        const http = require('http');
        const log = [];
        http.createServer((req, res) => {
          log.push('server request');
          req.on('aborted', () => log.push('server aborted'));
          req.on('close', () => log.push('server req close'));
          res.on('close', () => {
            log.push('server res close');
            setTimeout(() => process.send({ child: log.join(',') }), 50);
          });
          res.writeHead(200);
          res.write('a');
        }).listen(3021, () => process.send('listening'));
        process.on('message', (m) => {
          if (m !== 'client') return;
          // To the parent's server, which learns this client went away.
          const req = http.get('http://localhost:3020/', (res) => {
            res.on('error', () => {});
            setTimeout(() => {
              req.destroy();
              setTimeout(() => process.send('client done'), 50);
            }, 20);
          });
          req.on('error', () => {});
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const events = 'server request,server aborted,server res close,server req close';
  assert.deepEqual(out.stdout.trim().split('\n'), [`child server: ${events}`, `parent server: ${events}`]);
});

test('http: what a response wrote in the tick it is destroyed in does not go out: its client sees only the reset', async () => {
  const out = await h.run({ 'main.js': `
        const http = require('http');
        http.createServer((req, res) => {
          res.write('a');
          res.destroy(new Error('x'));
        }).listen(3012, () => {
          const log = [];
          http.get('http://localhost:3012/', (res) => {
            log.push('response ' + res.statusCode);
            res.on('error', (e) => log.push('res error ' + e.code));
            res.on('aborted', () => log.push('res aborted'));
          }).on('error', (e) => log.push('req error ' + e.code + ' ' + e.message));
          setTimeout(() => {
            console.log(log.join(','));
            process.exit(0);
          }, 200);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'req error ECONNRESET socket hang up\n');
});

test("http: req.destroy(err) with a response in flight: the request's error, then the response is aborted", async () => {
  const out = await h.run({ 'main.js': `
        const http = require('http');
        http.createServer((req, res) => {
          res.writeHead(200);
          res.write('a');
        }).listen(3013, () => {
          const log = [];
          const req = http.get('http://localhost:3013/', (res) => {
            log.push('response');
            res.on('aborted', () => log.push('res aborted'));
            res.on('error', (e) => log.push('res error ' + e.code + ' ' + e.message));
            res.on('close', () => log.push('res close'));
            req.destroy(new Error('mine'));
          });
          req.on('error', (e) => log.push('req error ' + e.message));
          req.on('close', () => log.push('req close'));
          setTimeout(() => {
            console.log(log.join(','));
            process.exit(0);
          }, 200);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'response,req error mine,res aborted,req close,res error ECONNRESET aborted,res close\n');
});

test("http: req.setTimeout(ms, cb) and the timeout option emit 'timeout' once the request is idle that long", async () => {
  const out = await h.run({ 'main.js': `
        // req.setTimeout(ms, cb), and http.get's timeout option, on a request its server never answers.
        const http = require('http');
        const lines = [];
        http.createServer(() => {}).listen(3014, async () => {
          lines.push(await new Promise((done) => {
            const log = [];
            const req = http.get('http://localhost:3014/');
            req.setTimeout(50, () => {
              log.push('timeout cb');
              req.destroy();
            });
            req.on('timeout', () => log.push('req timeout'));
            req.on('error', (e) => log.push('req error ' + e.code));
            req.on('close', () => done(log.concat('req close').join(' | ')));
          }));
          lines.push(await new Promise((done) => {
            const log = [];
            const req = http.get({ port: 3014, path: '/', timeout: 50 });
            req.on('timeout', () => {
              log.push('req timeout');
              req.destroy();
            });
            req.on('error', (e) => log.push('req error ' + e.code));
            req.on('close', () => done(log.concat('req close').join(' | ')));
          }));
          console.log(lines.join('\\n'));
          process.exit(0);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['timeout cb | req timeout | req error ECONNRESET | req close', 'req timeout | req error ECONNRESET | req close']);
});

test("http: a request's timeout counts idle time: not while its response keeps coming, nor once it completed", async () => {
  const out = await h.run({ 'main.js': `
        // The timeout counts idle time only: a response that keeps coming (a chunk each 100 ms for 3 s,
        // timeout 1 s: each gap far from it, so that a late loop does not time it out) is not timed out,
        // and a request that completed is not timed out after. Each case is reported once its request
        // closed and twice the timeout went by, whatever the machine's speed.
        const http = require('http');
        const lines = [];
        http.createServer((req, res) => {
          if (req.url === '/quick') return res.end('done');
          let n = 0;
          res.writeHead(200);
          const tick = setInterval(() => {
            res.write('x');
            if (++n === 30) {
              clearInterval(tick);
              res.end();
            }
          }, 100);
        }).listen(3017, async () => {
          for (const path of ['/trickle', '/quick']) {
            lines.push(await new Promise((done) => {
              const log = [path];
              const req = http.get('http://localhost:3017' + path, (res) => {
                let body = '';
                res.on('data', (d) => (body += d));
                res.on('end', () => log.push('end ' + body));
              });
              req.setTimeout(1000, () => log.push('timeout'));
              req.on('close', () => {
                log.push('req close');
                setTimeout(() => done(log.join(' | ')), 2000);
              });
            }));
          }
          console.log(lines.join('\\n'));
          process.exit(0);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['/trickle | end ' + 'x'.repeat(30) + ' | req close', '/quick | end done | req close']);
});

test("http: a response's start is activity for its request's timeout", async () => {
  const out = await h.run({ 'main.js': `
        // The response's start is activity too: headers halfway into the timeout (1 of 2 s), the body after
        // the timeout would have come without them (2.1 s), each a second from the next deadline (a late
        // loop runs timers due together in one phase: close ones could come in either order). Reported once
        // the request closed.
        const http = require('http');
        http.createServer((req, res) => {
          setTimeout(() => res.flushHeaders(), 1000);
          setTimeout(() => res.end('late'), 2100);
        }).listen(3018, () => {
          const log = [];
          const req = http.get('http://localhost:3018/', (res) => {
            log.push('response');
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => log.push('end ' + body));
          });
          req.setTimeout(2000, () => log.push('timeout'));
          req.on('close', () => {
            console.log(log.concat('req close').join(' | '));
            process.exit(0);
          });
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'response | end late | req close\n');
});

test("http: an agent's queued request destroyed with no 'error' listener (its error uncaught, and handled) frees its turn: the next request completes", async () => {
  const out = await h.run({ 'main.js': `
        // maxSockets 1: a queued request destroyed with no 'error' listener (its error uncaught, and handled):
        // the request after it still gets the socket and completes.
        const http = require('http');
        const log = [];
        process.on('uncaughtException', (e) => log.push('uncaught ' + e.message));
        http.createServer((req, res) => setTimeout(() => res.end(req.url), 30)).listen(3021, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          const get = (path, cb) => http.get(\`http://localhost:3021\${path}\`, { agent }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { log.push('got ' + b); cb?.(); }); });
          get('/a');
          const b = get('/b');
          b.destroy();
          get('/c', () => setTimeout(() => { console.log(log.join(', ')); process.exit(0); }, 20));
          setTimeout(() => { console.log(log.join(', ') + ' | TIMING: not over in 3000 ms'); process.exit(0); }, 3000);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'got /a, uncaught socket hang up, got /c\n');
});

test("http: an agent's maxSockets: its requests to a host wait for one of its sockets", async () => {
  const out = await h.run({ 'main.js': `
        // An agent's maxSockets: its requests to a host go one at a time (here, one socket).
        const http = require('http');
        const log = [];
        let active = 0;
        http.createServer((req, res) => {
          active++;
          log.push('start ' + req.url + ' active=' + active);
          setTimeout(() => {
            active--;
            res.end('x');
          }, 50);
        }).listen(3015, () => {
          const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
          let n = 0;
          for (const path of ['/a', '/b', '/c']) {
            http.get({ port: 3015, path, agent }, (res) => {
              res.resume();
              res.on('end', () => {
                if (++n < 3) return;
                console.log(log.join(' | '));
                process.exit(0);
              });
            });
          }
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'start /a active=1 | start /b active=1 | start /c active=1\n');
});

test("http: stray loopback messages after cancel: what a child's server sent for a request its parent cancelled reaches no one", async () => {
  const out = await h.run(
    {
      'main.js': `
        // Requests to a child's server cancelled mid-stream (its response destroyed) or as it answers with a
        // cookie (the request destroyed): what the child had already sent for them goes nowhere.
        const http = require('http');
        const { fork } = require('child_process');
        const child = fork(__dirname + '/child.js');
        child.on('message', async () => {
          let n = 0;
          for (let i = 0; i < 20; i++) {
            await new Promise((done) => {
              const req = http.get('http://localhost:3040/stream', (res) => {
                res.on('error', () => {});
                res.once('data', () => {
                  res.destroy();
                  setTimeout(done, 10);
                });
              });
              req.on('error', () => done());
            });
            await new Promise((done) => {
              const req = http.get('http://localhost:3040/cookie', (res) => res.resume());
              req.on('error', () => {});
              setTimeout(() => {
                req.destroy();
                setTimeout(done, 10);
              }, i % 4);
            });
            n++;
          }
          console.log('done ' + n);
          child.kill();
          process.exit(0);
        });`,
      'child.js': `
        require('http').createServer((req, res) => {
          if (req.url === '/cookie') {
            res.setHeader('set-cookie', 'stray=1');
            return res.end('c');
          }
          res.writeHead(200);
          const tick = setInterval(() => res.write('x'.repeat(100)), 1);
          res.on('close', () => clearInterval(tick));
        }).listen(3040, () => process.send('ready'));`,
    },
    '/app/main.js',
    [],
    undefined,
    // What the child sent last comes after: the run is kept to see it.
    { linger: 500 },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'done 20\n');
  assert.deepEqual(out.stray, []);
});

test('http: res.flushHeaders() sends the headers at once: a destroy right after cuts the response short', async () => {
  const out = await h.run({ 'main.js': `
        // res.flushHeaders() sends the headers at once: a destroy right after cuts the response short, not the request.
        const http = require('http');
        http.createServer((req, res) => {
          res.writeHead(200);
          res.flushHeaders();
          res.destroy();
        }).listen(3030, () => {
          const log = [];
          http.get('http://localhost:3030/', (res) => {
            log.push('response ' + res.statusCode);
            res.on('aborted', () => log.push('aborted'));
            res.on('error', (e) => log.push('res error ' + e.code));
          }).on('error', (e) => log.push('req error ' + e.code + ' ' + e.message));
          setTimeout(() => {
            console.log(log.join(', '));
            process.exit(0);
          }, 200);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'response 200, aborted, res error ECONNRESET\n');
});

test("http: a request's timeout starts once it has a socket, not while it waits for one of its agent's", async () => {
  const out = await h.run({ 'main.js': `
        // A request's timeout starts once it has a socket, not while it waits in its agent's queue: /a (600 ms)
        // times out at 300; /b (50 ms) waits for its socket meanwhile, then is answered. Reported once both
        // closed and twice the timeout went by, whatever the machine's speed.
        const http = require('http');
        const log = [];
        http.createServer((req, res) => setTimeout(() => res.end('x'), req.url === '/a' ? 600 : 50)).listen(3031, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          let open = 2;
          for (const path of ['/a', '/b']) {
            const req = http.get({ port: 3031, path, agent, timeout: 300 }, (res) => {
              res.resume();
              res.on('end', () => log.push('end ' + path));
            });
            req.on('timeout', () => {
              log.push('timeout ' + path);
              req.destroy();
            });
            req.on('error', (e) => log.push('error ' + path + ' ' + e.code));
            req.on('close', () => {
              if (--open) return;
              setTimeout(() => {
                console.log(log.join(' | '));
                process.exit(0);
              }, 600);
            });
          }
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'timeout /a | error /a ECONNRESET | end /b\n');
});

test("http: an agent's requests get its sockets in the order they were made", async () => {
  const out = await h.run({ 'main.js': `
        // An agent's queue goes in the order the requests were made, not the order they were ended.
        const http = require('http');
        const log = [];
        http.createServer((req, res) => {
          log.push(req.url);
          setTimeout(() => res.end('x'), 30);
        }).listen(3032, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          const reqs = ['/a', '/b', '/c'].map((path) => http.request({ port: 3032, path, agent }, (res) => res.resume()));
          for (const req of reqs.reverse()) req.end();
          setTimeout(() => {
            console.log(log.join(' '));
            process.exit(0);
          }, 400);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, '/a /b /c\n');
});

test("http: a request made and not ended keeps its agent's socket", async () => {
  const out = await h.run({ 'main.js': `
        // A request made and not ended holds its agent's socket: the next waits until it is ended (and answered).
        const http = require('http');
        const log = [];
        http.createServer((req, res) => {
          log.push('start ' + req.url);
          res.end('x');
        }).listen(3035, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          const a = http.request({ port: 3035, path: '/a', agent }, (res) => res.resume());
          http.get({ port: 3035, path: '/b', agent }, (res) => res.resume());
          setTimeout(() => {
            log.push('ending /a');
            a.end();
          }, 150);
          setTimeout(() => {
            console.log(log.join(' | '));
            process.exit(0);
          }, 400);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'ending /a | start /a | start /b\n');
});

test("http: a request's 'timeout' comes once (setTimeout again in its handler makes no other)", async () => {
  const out = await h.run({ 'main.js': `
        // 'timeout' comes once: setTimeout again in its handler does not make another (it would at 500 ms, before
        // the response at 1200). Reported once the request closed.
        const http = require('http');
        http.createServer((req, res) => setTimeout(() => res.end('x'), 1200)).listen(3033, () => {
          const log = [];
          const req = http.get('http://localhost:3033/', (res) => {
            res.resume();
            res.on('end', () => log.push('end'));
          });
          req.setTimeout(300, () => {
            log.push('timeout');
            req.setTimeout(200);
          });
          req.on('timeout', () => log.push('req timeout'));
          req.on('close', () => {
            log.push('close');
            console.log(log.join(' | '));
            process.exit(0);
          });
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'timeout | req timeout | end | close\n');
});

test('http: req.destroy() then req.abort() in the same tick, before a response: it was aborted (no error)', async () => {
  const out = await h.run({ 'main.js': `
        // req.destroy() then req.abort() in the same tick, before a response.
        const http = require('http');
        http.createServer((req, res) => res.end('ok')).listen(3034, () => {
          const log = [];
          const req = http.get('http://localhost:3034/');
          req.on('abort', () => log.push('abort'));
          req.on('error', (e) => log.push('error ' + e.message));
          req.on('close', () => log.push('close'));
          req.destroy();
          req.abort();
          setTimeout(() => {
            console.log(log.join(', '));
            process.exit(0);
          }, 200);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'close, abort\n');
});

test("http: a child that dies with a request to its sibling's server (through their parent) aborts it there", async () => {
  const out = await h.run(
    {
      'main.js': `
        // A child's request to its sibling's server (through their parent): the child dies, and its sibling's server learns it.
        const { fork } = require('child_process');
        const server = fork(__dirname + '/server.js');
        server.on('message', (m) => {
          if (m === 'listening') {
            const client = fork(__dirname + '/client.js');
            client.on('message', () => client.kill());
          } else {
            console.log(m);
            server.kill();
            process.exit(0);
          }
        });`,
      'server.js': `
        const log = [];
        require('http').createServer((req, res) => {
          log.push('request');
          req.on('aborted', () => log.push('aborted'));
          req.on('close', () => log.push('req close'));
          res.on('close', () => {
            log.push('res close');
            setTimeout(() => process.send(log.join(',')), 50);
          });
          res.writeHead(200);
          res.write('a');
        }).listen(3041, () => process.send('listening'));`,
      'client.js': `
        require('http').get('http://localhost:3041/', (res) => res.once('data', () => process.send('got')));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'request,aborted,res close,req close\n');
});

test("http: a child's server that flushes its headers and is destroyed: its client in the parent gets the response, then its abort", async () => {
  const out = await h.run(
    {
      'main.js': `
        // A child's server sends its headers (flushHeaders) and is destroyed: its client here gets the response,
        // then its abort; what the server wrote in the same tick after its headers does not come.
        const http = require('http');
        const { fork } = require('child_process');
        const child = fork(__dirname + '/child.js');
        child.on('message', async () => {
          const lines = [];
          for (const path of ['/flush', '/flush-write']) {
            lines.push(await new Promise((done) => {
              const log = [path];
              http.get('http://localhost:3050' + path, (res) => {
                log.push('response ' + res.statusCode);
                res.on('data', (d) => log.push('data ' + d));
                res.on('aborted', () => log.push('aborted'));
                res.on('error', (e) => log.push('res error ' + e.code));
                res.on('close', () => setTimeout(() => done(log.join(', ')), 20));
              }).on('error', (e) => done(log.concat('req error ' + e.code + ' ' + e.message).join(', ')));
            }));
          }
          console.log(lines.join('\\n'));
          child.kill();
          process.exit(0);
        });`,
      'child.js': `
        require('http').createServer((req, res) => {
          res.writeHead(200);
          res.flushHeaders();
          if (req.url === '/flush-write') res.write('a');
          res.destroy();
        }).listen(3050, () => process.send('ready'));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['/flush, response 200, aborted, res error ECONNRESET', '/flush-write, response 200, aborted, res error ECONNRESET']);
});

test('http: a server that flushes its headers and is destroyed: the page gets the response start, then the error, and nothing written after', async () => {
  const out = await h.run(
    {
      'main.js': `
        require('http').createServer((req, res) => {
          res.writeHead(200);
          res.flushHeaders();
          if (req.url === '/flush-write') res.write('a');
          res.destroy();
        }).listen(3000);`,
    },
    '/app/main.js',
    [{ url: '/flush' }, { url: '/flush-write' }],
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.ends, [['response-error', 0], ['response-error', 1]]);
  assert.deepEqual(out.responses.map((r) => [r.status, r.body]), [[200, ''], [200, '']]);
});

test('http: destroy() then abort(), or abort() alone, once the request has its socket: \'abort\', the error (socket hang up), then \'close\'', async () => {
  const out = await h.run({ 'main.js': `
        // destroy() then abort(), and abort() alone, once the request has its socket (20 ms in), before a response.
        const http = require('http');
        const lines = [];
        http.createServer(() => {}).listen(3051, async () => {
          for (const how of ['destroy+abort', 'abort']) {
            lines.push(await new Promise((done) => {
              const log = [how + ':'];
              const req = http.get('http://localhost:3051/');
              req.on('abort', () => log.push('abort'));
              req.on('error', (e) => log.push('error ' + e.message));
              req.on('close', () => {
                log.push('close');
                setTimeout(() => done(log.join(' ')), 20);
              });
              setTimeout(() => {
                if (how === 'destroy+abort') req.destroy();
                req.abort();
              }, 20);
            }));
          }
          console.log(lines.join('\\n'));
          process.exit(0);
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'destroy+abort: abort error socket hang up close\nabort: abort error socket hang up close\n');
});

test("http: a response nobody listens for is read and dropped: its request closes and frees its agent's socket", async () => {
  const out = await h.run({ 'main.js': `
        // A response nobody listens for is read and dropped: its request closes, and frees its agent's socket.
        const http = require('http');
        const log = [];
        http.createServer((req, res) => res.end('x')).listen(3052, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          const r1 = http.get({ port: 3052, path: '/1', agent });
          r1.on('close', () => log.push('r1 close'));
          http.get({ port: 3052, path: '/2', agent }, (res) => {
            res.resume();
            res.on('end', () => {
              log.push('r2 end');
              // Without an agent too.
              const r3 = http.get('http://localhost:3052/3');
              r3.on('close', () => {
                log.push('r3 close');
                console.log(log.join(', '));
                process.exit(0);
              });
            });
          });
        });` }, '/app/main.js');
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'r1 close, r2 end, r3 close\n');
});

test("process.exit() in an 'uncaughtException' or 'unhandledRejection' handler ends the process with its code", async () => {
  const outs = [];
  for (const program of [
    `
      process.on('uncaughtException', (e) => {
        console.log('caught ' + e.message);
        process.exit(4);
      });
      setTimeout(() => {
        throw new Error('boom');
      }, 10);
      setTimeout(() => console.log('still alive'), 500);`,
    `
      process.on('unhandledRejection', (e) => {
        console.log('rejected ' + e.message);
        process.exit(5);
      });
      setTimeout(() => Promise.reject(new Error('nope')), 10);
      setTimeout(() => console.log('still alive'), 500);`,
  ]) {
    const out = await h.run({ 'main.js': program }, '/app/main.js');
    assert.equal(out.fatal, null, out.fatal ?? out.stderr);
    outs.push([out.stdout, out.exit]);
  }
  assert.deepEqual(outs, [['caught boom\n', 4], ['rejected nope\n', 5]]);
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

test('child_process: execSync, execFileSync and spawnSync run Node programs and shell commands while the caller waits', async () => {
  const out = await h.run(
    {
      'main.js': `
        // Called before the program has run a task: the helper that starts the child is waited for.
        const cp = require('child_process');
        const fs = require('fs');
        const out = {};
        out.top = cp.execSync('node -e "console.log(6 * 7)"', { encoding: 'utf8' });
        fs.writeFileSync('from-parent.txt', 'shared');
        out.execSync = cp.execSync('node child.js one "two words"');
        out.execFileSync = cp.execFileSync(process.execPath, ['child.js', 'three'], { encoding: 'utf8', env: { GREETING: 'hello' } });
        const r = cp.spawnSync(process.execPath, ['-e', 'require("fs").writeFileSync("from-child.txt", "written"); console.error("to stderr")']);
        out.spawnSync = [r.status, r.signal, r.stdout, r.stderr.toString(), r.output.map((o) => o && o.toString()), Buffer.isBuffer(r.stdout), typeof r.pid, 'error' in r];
        out.fromChild = fs.readFileSync('from-child.txt', 'utf8');
        out.shell = cp.spawnSync('echo a && node -p "1 + 1" && echo b', { shell: true, encoding: 'utf8' }).stdout;
        out.nested = cp.execSync(\`node -e "console.log(require('child_process').execSync('node -p 2+3', { encoding: 'utf8' }).trim())"\`, { encoding: 'utf8' });
        console.log(JSON.stringify(out));`,
      'child.js': `
        console.log(JSON.stringify({ argv: process.argv.slice(2), greeting: process.env.GREETING, read: require('fs').readFileSync('from-parent.txt', 'utf8') }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const shown = JSON.stringify({ argv: ['one', 'two words'], read: 'shared' });
  assert.deepEqual(JSON.parse(out.stdout), {
    top: '42\n',
    execSync: { type: 'Buffer', data: [...Buffer.from(`${shown}\n`)] },
    execFileSync: `${JSON.stringify({ argv: ['three'], greeting: 'hello', read: 'shared' })}\n`,
    spawnSync: [0, null, { type: 'Buffer', data: [] }, 'to stderr\n', [null, '', 'to stderr\n'], true, 'number', false],
    fromChild: 'written',
    shell: 'a\n2\nb\n',
    nested: '5\n',
  });
});

test("child_process: a synchronous command's non-zero exit: execSync and execFileSync throw Node's error, spawnSync reports the status", async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const n = process.execPath;
        const out = {};
        const thrown = (f) => {
          try {
            return ['returned', f()];
          } catch (e) {
            return [e.message.replace(process.execPath, "node"), e.status, e.signal, String(e.stdout), String(e.stderr), Object.keys(e)];
          }
        };
        out.execSync = thrown(() => cp.execSync('node -e "console.log(\\'out\\'); console.error(\\'err\\'); process.exit(3)"', { stdio: 'pipe' }));
        out.execSyncShell = thrown(() => cp.execSync('exit 2'));
        out.execFileSync = thrown(() => cp.execFileSync(n, ['-e', 'process.exitCode = 4'], { stdio: 'pipe' }));
        const r = cp.spawnSync(n, ['-e', 'throw new Error("boom")'], { encoding: 'utf8' });
        out.spawnSync = [r.status, r.signal, r.stderr.includes('Error: boom'), 'error' in r];
        // Not a Node program: the shell cannot find it (127; natively git runs).
        out.notNode = [cp.spawnSync("git", ["rev-parse", "HEAD"]).status, cp.spawnSync("git", ["status"], { encoding: "utf8" }).stderr];
        console.log(JSON.stringify(out));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const keys = ['status', 'signal', 'output', 'pid', 'stdout', 'stderr'];
  assert.deepEqual(JSON.parse(out.stdout), {
    execSync: [`Command failed: node -e "console.log('out'); console.error('err'); process.exit(3)"\nerr\n`, 3, null, 'out\n', 'err\n', keys],
    execSyncShell: ['Command failed: exit 2', 2, null, '', '', keys],
    execFileSync: ['Command failed: node -e process.exitCode = 4', 4, null, '', '', keys],
    spawnSync: [1, null, true, false],
    notNode: [127, 'sh: git: not found (only Node programs run in the browser runtime)\n'],
  });
});

test('child_process: a synchronous command past its timeout is killed: ETIMEDOUT, with the kill signal', { timeout: 60_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const out = {};
        let t = Date.now();
        const r = cp.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 1000 });
        out.spawnSync = [r.error.code, r.error.errno, r.status, r.signal, Date.now() - t >= 1000, Date.now() - t < 20000];
        t = Date.now();
        try {
          cp.execSync('sleep 10', { timeout: 300 });
        } catch (e) {
          out.execSync = [e.message, e.code, e.status, e.signal, Date.now() - t >= 300, Date.now() - t < 5000];
        }
        try {
          cp.execFileSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: 'SIGKILL' });
        } catch (e) {
          out.execFileSync = [e.code, e.status, e.signal];
        }
        console.log(JSON.stringify(out));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    spawnSync: ['ETIMEDOUT', -110, null, 'SIGTERM', true, true],
    execSync: ['spawnSync /bin/sh ETIMEDOUT', 'ETIMEDOUT', null, 'SIGTERM', true, true],
    execFileSync: ['ETIMEDOUT', null, 'SIGKILL'],
  });
});

test("child_process: a synchronous command's input is its stdin", async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const upper = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(s.toUpperCase()))';
        console.log(JSON.stringify({
          spawnSync: cp.spawnSync(process.execPath, ['-e', upper], { input: 'abc', encoding: 'utf8' }).stdout,
          execSync: cp.execSync(\`node -e '\${upper}'\`, { input: Buffer.from('from a buffer') }).toString(),
          execFileSync: cp.execFileSync(process.execPath, ['-e', upper], { input: new Uint8Array([104, 105]), encoding: 'utf8' }),
          none: cp.execFileSync(process.execPath, ['-e', upper], { encoding: 'utf8' }),
        }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { spawnSync: 'ABC\n', execSync: 'FROM A BUFFER\n', execFileSync: 'HI\n', none: '\n' });
});

test('child_process: a synchronous command whose output passes maxBuffer is killed: ENOBUFS', async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const out = {};
        const t = Date.now();
        const r = cp.spawnSync(process.execPath, ['-e', 'console.log("x".repeat(100)); setTimeout(() => {}, 60000)'], { maxBuffer: 10, encoding: 'utf8' });
        out.spawnSync = [r.error.code, r.error.errno, r.status, r.signal, r.stdout.length, Date.now() - t < 20000];
        try {
          cp.execSync('node -p 1234567', { maxBuffer: 3 });
        } catch (e) {
          out.execSync = [e.message, e.code, e.status, e.signal, String(e.stdout)];
        }
        out.within = cp.execFileSync(process.execPath, ['-p', '"y".repeat(9)'], { maxBuffer: 10, encoding: 'utf8' });
        console.log(JSON.stringify(out));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    spawnSync: ['ENOBUFS', -105, null, 'SIGTERM', 101, true],
    execSync: ['spawnSync /bin/sh ENOBUFS', 'ENOBUFS', null, 'SIGTERM', '1234567\n'],
    within: 'yyyyyyyyy\n',
  });
});

test("child_process: a synchronous command's stdio: pipe, ignore, inherit, and execSync's stderr shown by default", async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const n = process.execPath;
        const both = 'console.log("o"); console.error("e")';
        const show = (r) => [r.stdout === null ? null : String(r.stdout), r.stderr === null ? null : String(r.stderr), r.output && r.output.map((o) => (o === null ? null : String(o)))];
        console.log(JSON.stringify({
          pipe: show(cp.spawnSync(n, ['-e', both], { stdio: 'pipe' })),
          ignore: show(cp.spawnSync(n, ['-e', both], { stdio: 'ignore' })),
          inherit: show(cp.spawnSync(n, ['-e', both], { stdio: 'inherit' })),
          mixed: show(cp.spawnSync(n, ['-e', both], { stdio: ['pipe', 'ignore', 'pipe'] })),
          execInherit: cp.execSync(\`node -e '\${both}'\`, { stdio: 'inherit' }),
          // execSync's stderr goes to this process's unless stdio is given.
          execDefault: cp.execSync(\`node -e '\${both}'\`).toString(),
        }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines.pop()!), {
    pipe: ['o\n', 'e\n', [null, 'o\n', 'e\n']],
    ignore: [null, null, [null, null, null]],
    inherit: [null, null, [null, null, null]],
    mixed: [null, 'e\n', [null, null, 'e\n']],
    execInherit: null,
    execDefault: 'o\n',
  });
  // inherit (spawnSync's and execSync's) writes to this process's output; execSync shows its stderr after.
  assert.deepEqual(lines, ['o', 'o']);
  assert.equal(out.stderr, 'e\ne\ne\n');
});

test('child_process: a synchronous command the runtime cannot start yet fails at once, with an error that names the call', async () => {
  // The helper that starts a synchronous child's runtime is slow to start (a loaded machine): the
  // program runs without it after a while, and its synchronous commands fail instead of blocking forever.
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const out = {};
        try {
          cp.execSync('node -p 1');
        } catch (e) {
          out.execSync = [e.code, e.message.split(':')[0]];
        }
        const r = cp.spawnSync(process.execPath, ['-p', '1']);
        out.spawnSync = [r.error.code, r.status, r.error.message.split(':')[0]];
        out.result = [Object.keys(r), r.output, typeof r.stdout, typeof r.stderr];
        try {
          cp.execFileSync(process.execPath, ['-p', '1']);
        } catch (e) {
          out.execFileSync = [e.code, e.message.split(':')[0]];
        }
        console.log(JSON.stringify(out));`,
    },
    '/app/main.js',
    [],
    undefined,
    { prepare: 50, helperDelay: 10_000 },
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const why = "cannot run yet";
  assert.deepEqual(JSON.parse(out.stdout), {
    execSync: ['ENOSYS', `child_process.execSync("node -p 1") ${why}`],
    spawnSync: ['ENOSYS', null, `child_process.spawnSync("/usr/local/bin/node -p 1") ${why}`],
    execFileSync: ['ENOSYS', `child_process.execFileSync("/usr/local/bin/node -p 1") ${why}`],
    // As Node's result for a command that did not start: no output, stdout and stderr undefined.
    result: [['error', 'status', 'signal', 'output', 'pid', 'stdout', 'stderr'], null, 'undefined', 'undefined'],
  });
});

test('child_process: a child process in a project with an install runs synchronous commands as it starts', async () => {
  // A child process with an install starts a file helper of its own; it starts synchronous children
  // through the main runtime's, which is up (its own is not yet).
  const out = await h.runInstalled(
    {
      'main.js': `
        const cp = require('child_process');
        const r = cp.spawnSync(process.execPath, ['child.js'], { encoding: 'utf8' });
        console.log('sync', r.stdout.trim(), r.status);
        const c = cp.spawn(process.execPath, ['child.js']);
        c.stdout.on('data', (d) => console.log('async', String(d).trim()));`,
      'child.js': `console.log(require('child_process').execFileSync(process.execPath, ['-p', '6 * 7'], { encoding: 'utf8' }).trim());`,
    },
    { files: {}, bundled: [] },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stdout, 'sync 42 0\nasync 42\n', out.stderr);
});

test("child_process: the shell's sleep takes units, fractions and several numbers, as GNU sleep does, synchronously and not", { timeout: 60_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const out = {};
        let t = Date.now();
        out.units = cp.spawnSync('sleep 0.2s && sleep 0.1 0.1 && sleep .05 && echo slept', { shell: true, encoding: 'utf8' }).stdout;
        out.unitsWaited = Date.now() - t >= 400;
        out.invalid = ['abc', '', '1x', '1S'].map((a) => {
          const r = cp.spawnSync(\`sleep \${a}\`, { shell: true, encoding: 'utf8' });
          return [r.status, r.stderr];
        });
        out.hex = cp.execSync('sleep 0x0 0x0.1 0x1p-3 && echo slept', { encoding: 'utf8' });
        try {
          cp.execSync('sleep INF', { timeout: 300 });
        } catch (e) {
          out.inf = e.code;
        }
        t = Date.now();
        try {
          cp.execSync('sleep 1m', { timeout: 300 });
        } catch (e) {
          out.timeout = [e.code, Date.now() - t < 5000];
        }
        t = Date.now();
        cp.exec('sleep 0.2s && sleep 0.1 0.1 && echo slept', (err, stdout) => {
          out.async = [err, stdout, Date.now() - t >= 400];
          cp.exec('sleep abc', (err, stdout, stderr) => {
            out.asyncInvalid = [err.code, stderr];
            console.log(JSON.stringify(out));
          });
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const invalid = (what: string) => [1, `sleep: ${what}\nTry 'sleep --help' for more information.\n`];
  assert.deepEqual(JSON.parse(out.stdout), {
    units: 'slept\n',
    unitsWaited: true,
    invalid: [invalid("invalid time interval 'abc'"), invalid('missing operand'), invalid("invalid time interval '1x'"), invalid("invalid time interval '1S'")],
    hex: 'slept\n',
    inf: 'ETIMEDOUT',
    timeout: ['ETIMEDOUT', true],
    async: [null, 'slept\n', true],
    asyncInvalid: invalid("invalid time interval 'abc'"),
  });
});

test('child_process: a synchronous child killed (its timeout, or its blocked parent killed) takes its own synchronous children with it', { timeout: 60_000 }, async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const out = {};
        let ticks = 0;
        const channel = new BroadcastChannel('ticks');
        channel.onmessage = () => ticks++;
        const count = (then) => setTimeout(() => {
          ticks = 0;
          setTimeout(() => then(ticks), 1000);
        }, 300);
        try {
          cp.execSync('node mid.js', { timeout: 2000 });
        } catch (e) {
          out.timeout = e.code;
        }
        // The ticker ran while this thread waited (its ticks arrive now), and not after the timeout.
        setTimeout(() => {
          out.ticked = ticks > 0;
          count((n) => {
            out.afterTimeout = n;
            const c = cp.spawn(process.execPath, ['mid.js']);
            let seen = 0;
            channel.onmessage = () => {
              ticks++;
              if (++seen !== 3) return;
              c.kill();
              count((n) => {
                out.afterKill = n;
                console.log(JSON.stringify(out));
                process.exit(0);
              });
            };
          });
        }, 50);`,
      'mid.js': `require('child_process').execSync('node ticker.js');`,
      'ticker.js': `const b = new BroadcastChannel('ticks'); setInterval(() => b.postMessage(1), 50);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { timeout: 'ETIMEDOUT', ticked: true, afterTimeout: 0, afterKill: 0 });
});

test('child_process: execSync in a worker thread, and a synchronous child that reads, writes and prints megabytes', async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const fs = require('fs');
        const { Worker } = require('worker_threads');
        const w = new Worker("require('worker_threads').parentPort.postMessage(require('child_process').execSync('node -p 2+3', { encoding: 'utf8' }))", { eval: true });
        w.on('message', (m) => {
          fs.writeFileSync('big.txt', 'x'.repeat(5 << 20));
          const r = cp.spawnSync(process.execPath, ['-e', 'const fs = require("fs"); const s = fs.readFileSync("big.txt", "utf8"); fs.writeFileSync("copy.txt", s + "!"); process.stdout.write(s.slice(0, 3 << 20))'], { maxBuffer: 8 << 20 });
          console.log(JSON.stringify({ thread: m, large: [r.status, r.stdout.length, fs.readFileSync('copy.txt', 'utf8').length] }));
          process.exit(0);
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { thread: '5\n', large: [0, 3 << 20, (5 << 20) + 1] });
});

test('child_process: a numeric killSignal is reported by name, and node without a script runs its input', async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const n = process.execPath;
        const r = cp.spawnSync(n, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: 9 });
        console.log(JSON.stringify({
          numericSignal: [r.error.code, r.signal],
          inputScript: cp.spawnSync(n, [], { input: 'console.log(6 * 7)', encoding: 'utf8' }).stdout,
          noScript: [cp.spawnSync(n, [], { encoding: 'utf8' }).status, cp.spawnSync(n, [], { encoding: 'utf8' }).stdout],
          execInput: cp.execSync('node', { input: 'console.log(5)', encoding: 'utf8' }),
          dash: cp.spawnSync(n, ['-', 'a'], { input: 'console.log(JSON.stringify(process.argv.slice(1)))', encoding: 'utf8' }).stdout,
          stdinArgv: cp.spawnSync(n, [], { input: 'console.log(JSON.stringify(process.argv.slice(1)))', encoding: 'utf8' }).stdout,
          nullSignal: cp.spawnSync(n, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: null }).signal,
          badSignal: [{}, true].map((killSignal) => {
            try {
              cp.spawnSync(n, ['-e', '1'], { killSignal });
              return 'ran';
            } catch (e) {
              return [e.name, e.code, e.message];
            }
          }),
          aliasSignal: cp.spawnSync(n, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: 'sigiot' }).signal,
          unknownSignal: [99, 0, 'SIGFOO', '15'].map((killSignal) => {
            try {
              cp.spawnSync(n, ['-e', '1'], { killSignal });
              return 'ran';
            } catch (e) {
              return [e.name, e.code, e.message];
            }
          }),
        }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const unknown = (s: string) => ['TypeError', 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${s}`];
  assert.deepEqual(JSON.parse(out.stdout), {
    numericSignal: ['ETIMEDOUT', 'SIGKILL'],
    inputScript: '42\n',
    noScript: [0, ''],
    execInput: '5\n',
    dash: '["-","a"]\n',
    stdinArgv: '[]\n',
    nullSignal: 'SIGTERM',
    badSignal: [
      ['TypeError', 'ERR_INVALID_ARG_TYPE', 'The "options.killSignal" property must be one of type string or number. Received an instance of Object'],
      ['TypeError', 'ERR_INVALID_ARG_TYPE', 'The "options.killSignal" property must be one of type string or number. Received type boolean (true)'],
    ],
    aliasSignal: 'SIGABRT',
    unknownSignal: [unknown('99'), unknown('0'), unknown('SIGFOO'), unknown('15')],
  });
});

test('child_process: node -v and --version print the version, synchronously and not, whatever else node is given', async () => {
  const out = await h.run(
    {
      'main.js': `
        const cp = require('child_process');
        const n = process.execPath;
        const sync = [
          cp.execSync('node -v', { encoding: 'utf8' }),
          cp.spawnSync(n, ['--version'], { encoding: 'utf8' }).stdout,
          cp.execFileSync(n, ['-v', 'missing.js'], { encoding: 'utf8' }),
          cp.execSync('node -e "console.log(1)" -v', { encoding: 'utf8' }),
        ];
        cp.exec('node --version', (err, stdout) => console.log(JSON.stringify({ version: process.version, sync, async: [err, stdout] })));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const { version, sync, async } = JSON.parse(out.stdout) as { version: string; sync: string[]; async: [unknown, string] };
  assert.deepEqual({ sync, async }, { sync: Array(4).fill(`${version}\n`), async: [null, `${version}\n`] });
});
