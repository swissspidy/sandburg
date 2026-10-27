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
