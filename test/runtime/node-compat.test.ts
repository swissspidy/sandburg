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
  });
});
