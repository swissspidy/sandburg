// The loop under load, in child processes (a process ends when its loop has nothing left): every
// immediate runs before the process exits, 100k of them in time (under 5 s), and in an I/O callback
// the immediates it queued all run before a timer it set.
const { spawn } = require('child_process');
const fs = require('fs');
const cases = {
  slow() {
    let n = 0;
    for (let i = 0; i < 100; i++) setImmediate(() => { const end = Date.now() + 30; while (Date.now() < end); n++; });
    process.on('exit', () => console.log(`slow: ${n} of 100 ran before the exit`));
  },
  many() {
    let n = 0;
    const t = performance.now();
    for (let i = 0; i < 100000; i++) setImmediate(() => { if (++n === 100000) console.log(`many: all ran, under 5 s: ${performance.now() - t < 5000}`); });
    process.on('exit', () => console.log(`many: ${n} ran before the exit`));
  },
  io() {
    fs.readFile(__filename, () => {
      let n = 0;
      setTimeout(() => console.log(`io: ${n} of 20000 immediates before the timer`), 0);
      for (let i = 0; i < 20000; i++) setImmediate(() => n++);
    });
  },
  order() {
    const log = [];
    fs.readFile(__filename, () => {
      setTimeout(() => log.push('T0'), 0);
      setImmediate(() => { log.push('I1'); process.nextTick(() => log.push('tick1')); void Promise.resolve().then(() => log.push('p1')); setImmediate(() => log.push('I1.inner')); });
      setImmediate(() => log.push('I2'));
      setImmediate(() => log.push('I3'));
      process.nextTick(() => log.push('tick0'));
    });
    // T0 and I1.inner come in either order in Node (as 1 ms passed or not): only the rest is compared.
    setTimeout(() => console.log('order: ' + log.filter((e) => e !== 'I1.inner').join(' ')), 200);
  },
};
if (process.argv[2]) cases[process.argv[2]]();
else void (async () => {
  for (const c of Object.keys(cases)) await new Promise((done) => spawn(process.execPath, [__filename, c], { stdio: 'inherit' }).on('exit', done));
  process.exit(0);
})();
