// Timers set in the same millisecond, by performance.now() (the clock the runtime takes their time
// from, in whole ms), come due together: set right after a millisecond began (again if it ended while
// they were set), the first one's immediate comes after the others. Due at their exact times, they
// would part most times. (Node takes their time from libuv's clock, whose milliseconds do not begin
// with performance.now()'s: it parts them now and then, at a boundary of its own; see the test.)
let joined = 0, n = 0;
const one = () => {
  // The next millisecond's start.
  const start = Math.floor(performance.now());
  while (Math.floor(performance.now()) === start);
  const ms = Math.floor(performance.now());
  const log = [];
  const timers = [
    setTimeout(() => {
      log.push('a');
      setImmediate(() => log.push('imm'));
    }, 0),
    setTimeout(() => log.push('b'), 0),
    setTimeout(() => log.push('c'), 0),
  ];
  if (Math.floor(performance.now()) !== ms) {
    timers.forEach(clearTimeout);
    return void setImmediate(one);
  }
  setTimeout(() => {
    if (log.join() === 'a,b,c,imm') joined++;
    if (++n < 20) setImmediate(one);
    else console.log(`set in one millisecond, 20 times: in one phase ${joined} of 20`);
  }, 5);
};
one();
