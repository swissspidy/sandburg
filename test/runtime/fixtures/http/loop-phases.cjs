// The loop's phases as the runtime keeps them: what an immediate or a close callback queues
// (process.nextTick, promises) runs before the next one; close callbacks run last-closed first,
// after the immediates queued before them; an immediate queued in one runs on the next turn.
const http = require('http');
const log = [];
// Printed once the last two immediates ran (or a TIMING failure if that takes too long).
const push = (s) => {
  log.push(s);
  // (And a little later: anything after them would show.)
  if (log.includes('immediate from close') && log.includes('immediate from immediate 1')) setTimeout(() => {
    console.log(log.join('\n'));
    process.exit(0);
  }, 20);
};
let arrived = 0;
let destroy = () => {};
http.createServer(() => {
  // Once all three requests came.
  if (++arrived === 3) setTimeout(() => destroy(), 50);
}).listen(3080, () => {
  const reqs = [1, 2, 3].map((i) => {
    const r = http.get('http://localhost:3080/');
    r.on('error', () => {});
    r.on('close', () => {
      push('close ' + i);
      process.nextTick(() => push('tick after close ' + i));
      if (i === 1) setImmediate(() => push('immediate from close'));
    });
    return r;
  });
  destroy = () => {
    for (const r of reqs) r.destroy();
    setImmediate(() => {
      push('immediate 1');
      process.nextTick(() => push('tick after immediate 1'));
      void Promise.resolve().then(() => push('promise after immediate 1'));
      setImmediate(() => push('immediate from immediate 1'));
    });
    setImmediate(() => push('immediate 2'));
    setTimeout(() => {
      console.log(log.join('\n') + '\nTIMING: not over in 3000 ms');
      process.exit(0);
    }, 3000);
  };
});
