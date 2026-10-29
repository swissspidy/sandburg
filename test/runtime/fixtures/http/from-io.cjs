// What a server does from an I/O callback (here a child process's IPC message): its client in the same
// process hears it after the server's own side has closed (the next poll phase), not before.
const http = require('http');
const { fork } = require('child_process');
if (process.argv[2] === 'child') {
  setTimeout(() => {
    process.send('go');
    process.exit(0);
  }, 100);
  return;
}
const log = [];
// Printed once both ends closed (or a TIMING failure if that takes too long).
const print = (late) => {
  console.log(log.join('\n') + (late ? '\nTIMING: not over in 3000 ms' : ''));
  process.exit(0);
};
const push = (s) => {
  log.push(s);
  // (And a little later: anything after them would show.)
  if (log.includes('client close') && log.includes('server req close')) setTimeout(() => print(false), 20);
};
let held;
http.createServer((req, res) => {
  held = res;
  req.on('aborted', () => push('server aborted'));
  req.on('close', () => push('server req close'));
  res.on('close', () => push('server res close'));
}).listen(3084, () => {
  const c = http.get('http://localhost:3084/');
  c.on('error', (e) => push('client error ' + e.message));
  c.on('close', () => push('client close'));
  fork(__filename, ['child']).on('message', () => {
    push('message');
    held.destroy();
    setTimeout(() => print(true), 3000).unref();
  });
});
