/**
 * What the runtime let go of too late or never: each program ends, or goes on, only if it was let go.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

test("http: a response that came whole and is destroyed unread closes its request and frees its agent's socket", async () => {
  const out = await h.run(
    {
      'main.js': `
        const http = require('http');
        const server = http.createServer((req, res) => res.end('hello ' + req.url)).listen(3000, () => {
          const agent = new http.Agent({ maxSockets: 1 });
          const log = [];
          const whole = (res, then) => (res.complete ? then() : setImmediate(whole, res, then));
          // By the response, and by the request: both close it.
          const first = http.get({ port: 3000, path: '/a', agent }, (res) => whole(res, () => res.destroy()));
          first.on('close', () => log.push('first closed'));
          const second = http.get({ port: 3000, path: '/b', agent }, (res) => whole(res, () => second.destroy()));
          second.on('error', (e) => log.push('second error ' + e.message)).on('close', () => log.push('second closed'));
          // Each waits for the one before it to give the agent's one socket back.
          http.get({ port: 3000, path: '/c', agent }, (res) => {
            let body = '';
            res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => {
              console.log(JSON.stringify([...log, body]));
              server.close();
            });
          });
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), ['first closed', 'second closed', 'hello /c']);
  assert.equal(out.exit, 0);
});

test("a WebSocket its server rejects inside its 'upgrade' handler is not kept: the process exits once its server closes", async () => {
  const out = await h.runWebSocket(
    {
      'main.js': `
        const server = require('http').createServer((req, res) => res.end());
        server.on('upgrade', (req, socket) => {
          socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
          server.close();
        });
        server.listen(3000);`,
    },
    '/app/main.js',
    '/',
    [],
    [],
    true,
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.events, [['reject', 400, ''], ['exit', 0]]);
});
