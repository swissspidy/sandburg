// A runtime's messages about a request it does not answer are not taken: a sibling that posts a
// response (start, informational, chunk, end) for a request its parent sent to another child's server
// does not reach the client, which gets the server's own; nor does an informational response that is not
// 1xx from the server's own runtime. (In Node no program can post one: the same.)
const http = require('http');
const { fork } = require('child_process');
const role = process.argv[2];
if (role === 'server') {
  let id = null;
  // The runtime's own message that brought the request: its id, for the sibling to forge with.
  if (typeof globalThis.postMessage === 'function') globalThis.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'request' && e.data.port === 3093) id = e.data.id;
  });
  http.createServer((req, res) => {
    // (The runtime takes the message, and so the request, before this program's listener sees it.)
    setImmediate(() => process.send({ id }));
    process.once('message', () => {
      // Its own runtime may send informational responses for it, but only 1xx ones are.
      if (id !== null) for (const status of [200, 302, 99, 150.5]) globalThis.postMessage({ type: 'response-info', id, status, statusText: 'Not informational', headers: [['x-info', String(status)]] });
      setTimeout(() => res.end('real'), 20);
    });
  }).listen(3093, () => process.send('ready'));
} else if (role === 'forger') {
  process.send('ready');
  process.on('message', ({ id }) => {
    if (id !== null) {
      const post = (m) => globalThis.postMessage(m);
      post({ type: 'response-info', id, status: 103, statusText: 'Early Hints', headers: [['link', '</forged.css>']] });
      post({ type: 'response-start', id, status: 299, statusText: 'Forged', headers: [['x-forged', '1']] });
      post({ type: 'response-chunk', id, chunk: new TextEncoder().encode('forged') });
      post({ type: 'response-end', id });
    }
    // After what it posted (the parent takes messages in order, its IPC among them).
    setTimeout(() => process.send('forged'), 50);
  });
} else {
  const server = fork(__filename, ['server']);
  const forger = fork(__filename, ['forger']);
  let ready = 0;
  const go = () => {
    if (++ready < 2) return;
    server.once('message', (m) => forger.send(m));
    forger.once('message', () => server.send('go'));
    const req = http.get('http://localhost:3093/', (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        console.log(`client: ${res.statusCode} x-forged=${res.headers['x-forged'] ?? '-'} ${JSON.stringify(b)} information=${info.join(',') || 'none'}`);
        server.kill();
        forger.kill();
        process.exit(0);
      });
    });
    const info = [];
    req.on('information', (i) => info.push(i.statusCode));
  };
  server.once('message', go);
  forger.once('message', go);
}
