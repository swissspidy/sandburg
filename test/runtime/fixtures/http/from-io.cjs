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
let held;
http.createServer((req, res) => {
  held = res;
  req.on('aborted', () => log.push('server aborted'));
  req.on('close', () => log.push('server req close'));
  res.on('close', () => log.push('server res close'));
}).listen(3084, () => {
  const c = http.get('http://localhost:3084/');
  c.on('error', (e) => log.push('client error ' + e.message));
  c.on('close', () => log.push('client close'));
  fork(__filename, ['child']).on('message', () => {
    log.push('message');
    held.destroy();
    setTimeout(() => {
      console.log(log.join('\n'));
      process.exit(0);
    }, 100);
  });
});
