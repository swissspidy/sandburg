// Timers due together run in one timers phase: what one queues with process.nextTick or a promise runs
// before the next, and an immediate one queues waits for them all. Set from the main script, from an
// immediate, and from an I/O callback.
const fs = require('fs');
const out = [];
const run = (name, ms, done) => {
  const log = [];
  setTimeout(() => {
    log.push('a');
    process.nextTick(() => log.push('tick from a'));
    void Promise.resolve().then(() => log.push('promise from a'));
    setImmediate(() => log.push('imm from a'));
  }, ms);
  setTimeout(() => {
    log.push('b');
    process.nextTick(() => log.push('tick from b'));
  }, ms);
  setTimeout(() => log.push('c'), ms);
  setTimeout(() => {
    out.push(`${name}: ${log.join(', ')}`);
    done();
  }, ms + 50);
};
run('5 ms', 5, () => run('0 ms', 0, () => setImmediate(() => run('from an immediate', 5, () => fs.readFile(__filename, () => run('from an I/O callback', 5, () => console.log(out.join('\n'))))))));
