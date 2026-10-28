/**
 * Uncaught exceptions, unhandled rejections and signals in the runtime: each program's expected
 * output and exit code is what Node 24 gives for it. A program Node ends with its error (exit code 1,
 * the error on stderr) ends the runtime with that error (`fatal`), which its parent reports as exit
 * code 1.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

/** How a program ended: its stdout, and its exit code or (an end with its error) the error's first line. */
type End = { stdout: string; exit: number | null } | { stdout: string; fatal: string };

async function ends(files: Record<string, string>, main = '/app/main.js', execArgv?: string[], env?: Record<string, string>): Promise<End> {
  const out = await h.run(files, main, [], execArgv, { env });
  if (out.fatal) return { stdout: out.stdout, fatal: String(out.fatal).split('\n')[0] };
  return { stdout: out.stdout, exit: out.exit };
}

test("a top-level throw goes to 'uncaughtException' listeners: one that exits ends the process, after 'exit' listeners", async () => {
  const got = await ends({
    'main.js': `
      process.on('exit', (c) => console.log('exit', c));
      process.on('uncaughtException', (e, origin) => { console.log('caught', e.message, origin); process.exit(3); });
      throw new Error('top');`,
  });
  assert.deepEqual(got, { stdout: 'caught top uncaughtException\nexit 3\n', exit: 3 });
});

test('after a top-level throw a listener took, the event loop goes on: ticks, microtasks, immediates and timers run', async () => {
  const got = await ends({
    'main.js': `
      process.on('exit', (c) => console.log('exit', c, process.exitCode));
      process.on('uncaughtException', (e) => console.log('caught', e.message));
      setTimeout(() => console.log('timer fired'), 50);
      setImmediate(() => console.log('immediate'));
      process.nextTick(() => console.log('tick'));
      Promise.resolve().then(() => console.log('micro'));
      console.log('before');
      throw new Error('top');`,
  });
  assert.deepEqual(got, { stdout: 'before\ncaught top\ntick\nmicro\nimmediate\ntimer fired\nexit 0 undefined\n', exit: 0 });
});

test('process.exitCode set in the listener is the exit code; a throw in a required module and a thrown string are uncaught too', async () => {
  const outs = [];
  for (const files of [
    {
      'main.js': `
        process.on('exit', (c) => console.log('exit', c, process.exitCode));
        process.on('uncaughtException', () => { console.log('caught'); process.exitCode = 4; });
        throw new Error('top');`,
    },
    {
      'main.js': `
        process.on('exit', (c) => console.log('exit', c));
        process.on('uncaughtException', (e, origin) => { console.log('caught', e.message, origin); process.exitCode = 9; });
        setTimeout(() => console.log('timer fired'), 50);
        require('./dep.js');
        console.log('not reached');`,
      'dep.js': `throw new Error('dep');`,
    },
    {
      'main.js': `
        process.on('exit', (c) => console.log('exit', c));
        process.on('uncaughtException', (e, origin) => console.log('caught', e, origin));
        throw 'str';`,
    },
  ] as Record<string, string>[]) outs.push(await ends(files));
  assert.deepEqual(outs, [
    { stdout: 'caught\nexit 4 4\n', exit: 4 },
    { stdout: 'caught dep uncaughtException\ntimer fired\nexit 9\n', exit: 9 },
    { stdout: 'caught str uncaughtException\nexit 0\n', exit: 0 },
  ]);
});

test("an ES module's throw and its top-level await's rejection are uncaught with origin unhandledRejection; its process.exit() is at once", async () => {
  const outs = [];
  for (const files of [
    {
      'main.mjs': `
        process.on('exit', (c) => console.log('exit', c));
        process.on('uncaughtException', (e, origin) => console.log('caught', e.message, origin));
        setTimeout(() => console.log('timer fired'), 50);
        throw new Error('esm top');`,
    },
    {
      'main.mjs': `
        process.on('exit', (c) => console.log('exit', c));
        process.on('uncaughtException', (e, origin) => { console.log('caught', e.message, origin); process.exit(3); });
        throw new Error('esm top');`,
    },
    {
      // Not the 'unhandledRejection' listeners: the entry's rejection is uncaught at once.
      'main.mjs': `
        process.on('exit', (c) => console.log('exit', c));
        process.on('uncaughtException', (e, origin) => console.log('caught', e.message, origin));
        process.on('unhandledRejection', (e) => console.log('unhandled', e.message));
        setTimeout(() => console.log('timer fired'), 50);
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('tla');`,
    },
    {
      // process.exit() at an ES module's top level ends the process at once: what it queued does not run.
      'main.mjs': `
        process.on('exit', (c) => console.log('exit', c));
        Promise.resolve().then(() => console.log('micro'));
        process.nextTick(() => console.log('tick'));
        process.exit(2);`,
    },
    {
      'main.mjs': `import './dep.cjs'; console.log('not reached');`,
      'dep.cjs': `process.on('uncaughtException', (e, origin) => console.log('caught', e.message, origin)); throw new Error('cjs dep');`,
    },
  ] as Record<string, string>[]) outs.push(await ends(files, '/app/main.mjs'));
  assert.deepEqual(outs, [
    { stdout: 'caught esm top unhandledRejection\ntimer fired\nexit 0\n', exit: 0 },
    { stdout: 'caught esm top unhandledRejection\nexit 3\n', exit: 3 },
    { stdout: 'caught tla unhandledRejection\ntimer fired\nexit 0\n', exit: 0 },
    { stdout: 'exit 2\n', exit: 2 },
    { stdout: 'caught cjs dep unhandledRejection\n', exit: 0 },
  ]);
});

test("without a listener the process ends with the error, after 'exit' listeners ran with code 1", async () => {
  const outs = [];
  for (const [main, files] of [
    ['/app/main.js', { 'main.js': `process.exitCode = 5; process.on('exit', (c) => console.log('exit', c, process.exitCode)); setTimeout(() => console.log('never'), 50); throw new Error('top');` }],
    ['/app/main.js', { 'main.js': `process.on('exit', (c) => console.log('exit', c)); setTimeout(() => { throw new Error('t'); }, 10); setTimeout(() => console.log('never'), 50);` }],
    ['/app/main.mjs', { 'main.mjs': `process.on('exit', (c) => console.log('exit', c)); await new Promise((r) => setTimeout(r, 10)); throw new Error('tla');` }],
    // A listener that removes itself takes only the first.
    ['/app/main.js', { 'main.js': `process.on('exit', (c) => console.log('exit', c)); const once = (e) => { console.log('once', e.message); process.off('uncaughtException', once); }; process.on('uncaughtException', once); setTimeout(() => { throw new Error('a'); }, 5); setTimeout(() => { throw new Error('b'); }, 20); setTimeout(() => console.log('never'), 40);` }],
    // An 'exit' listener's process.exit() or exit code is the end; one that throws is ignored.
    ['/app/main.js', { 'main.js': `process.on('exit', (c) => { console.log('exit', c); process.exitCode = 9; }); throw new Error('x');` }],
    ['/app/main.js', { 'main.js': `process.on('exit', (c) => { console.log('exit', c); process.exit(6); }); process.on('exit', () => console.log('second')); throw new Error('x');` }],
    ['/app/main.js', { 'main.js': `process.on('exit', (c) => { console.log('exit', c); throw new Error('in exit'); }); process.on('exit', () => console.log('second')); throw new Error('x');` }],
  ] as const) outs.push(await ends(files, main));
  assert.deepEqual(outs, [
    { stdout: 'exit 1 1\n', fatal: 'Error: top' },
    { stdout: 'exit 1\n', fatal: 'Error: t' },
    { stdout: 'exit 1\n', fatal: 'Error: tla' },
    { stdout: 'once a\nexit 1\n', fatal: 'Error: b' },
    { stdout: 'exit 1\n', exit: 9 },
    { stdout: 'exit 1\n', exit: 6 },
    { stdout: 'exit 1\n', fatal: 'Error: x' },
  ]);
});

test("'uncaughtExceptionMonitor' sees each uncaught exception before the listeners, and does not take it", async () => {
  const outs = [];
  for (const program of [
    `process.on('exit', (c) => console.log('exit', c));
     process.on('uncaughtExceptionMonitor', (e, origin) => console.log('monitor', e.message, origin));
     throw new Error('top');`,
    `process.on('exit', (c) => console.log('exit', c));
     process.on('uncaughtException', (e, origin) => console.log('handler', e.message, origin));
     process.on('uncaughtExceptionMonitor', (e, origin) => console.log('monitor', e.message, origin));
     setTimeout(() => { throw new Error('later'); }, 10);
     throw new Error('top');`,
    `process.on('exit', (c) => console.log('exit', c));
     process.on('uncaughtException', (e, origin) => console.log('handler', e.message, origin));
     process.on('uncaughtExceptionMonitor', (e, origin) => console.log('monitor', e.message, origin));
     Promise.reject(new Error('rej'));
     setTimeout(() => console.log('timer'), 20);`,
  ]) outs.push(await ends({ 'main.js': program }));
  assert.deepEqual(outs, [
    { stdout: 'monitor top uncaughtException\nexit 1\n', fatal: 'Error: top' },
    { stdout: 'monitor top uncaughtException\nhandler top uncaughtException\nmonitor later uncaughtException\nhandler later uncaughtException\nexit 0\n', exit: 0 },
    { stdout: 'monitor rej unhandledRejection\nhandler rej unhandledRejection\ntimer\nexit 0\n', exit: 0 },
  ]);
});

test("a throw in an 'uncaughtException' listener, the monitor or the capture callback ends the process with code 7, without 'exit'", async () => {
  const outs = [];
  for (const program of [
    `process.on('uncaughtException', (e) => { console.log('caught', e.message); throw new Error('again'); }); setTimeout(() => console.log('timer'), 20); throw new Error('top');`,
    `process.on('uncaughtException', (e) => { console.log('caught', e.message); throw new Error('again'); }); setTimeout(() => { throw new Error('t'); }, 10); setTimeout(() => console.log('timer'), 50);`,
    `process.on('uncaughtException', () => { throw 'again'; }); throw new Error('x');`,
    `process.on('uncaughtExceptionMonitor', () => { throw new Error('mon'); }); process.on('uncaughtException', (e) => console.log('h', e.message)); throw new Error('x');`,
    `process.setUncaughtExceptionCaptureCallback(() => { throw new Error('cap'); }); throw new Error('x');`,
  ]) {
    const out = await h.run({ 'main.js': `process.on('exit', (c) => console.log('exit', c));\n${program}` }, '/app/main.js');
    outs.push([out.stdout, out.exit, out.fatal]);
  }
  assert.deepEqual(outs, [
    ['caught top\n', 7, null],
    ['caught t\n', 7, null],
    ['', 7, null],
    ['', 7, null],
    ['', 7, null],
  ]);
});

test('process.setUncaughtExceptionCaptureCallback takes uncaught exceptions and rejections in place of the listeners', async () => {
  const outs = [];
  for (const program of [
    `process.on('exit', (c) => console.log('exit', c));
     process.on('uncaughtException', (e) => console.log('handler', e.message));
     process.on('uncaughtExceptionMonitor', (e, o) => console.log('monitor', e.message, o));
     console.log('has', process.hasUncaughtExceptionCaptureCallback());
     process.setUncaughtExceptionCaptureCallback((e) => console.log('capture', e.message));
     console.log('has', process.hasUncaughtExceptionCaptureCallback());
     try { process.setUncaughtExceptionCaptureCallback(() => {}); } catch (e) { console.log(e.code, e.message); }
     try { process.setUncaughtExceptionCaptureCallback(1); } catch (e) { console.log(e.code, e.message); }
     setTimeout(() => { throw new Error('t'); }, 10);
     setTimeout(() => { process.setUncaughtExceptionCaptureCallback(null); console.log('has', process.hasUncaughtExceptionCaptureCallback()); throw new Error('t2'); }, 30);
     throw new Error('top');`,
    `process.on('exit', (c) => console.log('exit', c));
     process.setUncaughtExceptionCaptureCallback((e) => console.log('capture', e.message));
     Promise.reject(new Error('rej'));
     setTimeout(() => console.log('timer'), 20);`,
  ]) outs.push(await ends({ 'main.js': program }));
  assert.deepEqual(outs, [
    {
      stdout: [
        'has false',
        'has true',
        'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET `process.setupUncaughtExceptionCapture()` was called while a capture callback was already active',
        'ERR_INVALID_ARG_TYPE The "fn" argument must be of type function or null. Received type number (1)',
        'monitor top uncaughtException',
        'capture top',
        'monitor t uncaughtException',
        'capture t',
        'has false',
        'monitor t2 uncaughtException',
        'handler t2',
        'exit 0',
        '',
      ].join('\n'),
      exit: 0,
    },
    { stdout: 'capture rej\ntimer\nexit 0\n', exit: 0 },
  ]);
});

test('an unhandled rejection is uncaught (--unhandled-rejections=throw, the default) unless an unhandledRejection listener takes it', async () => {
  const outs = [];
  for (const program of [
    `process.on('exit', (c) => console.log('exit', c)); Promise.reject(new Error('rej')); setTimeout(() => console.log('timer'), 20);`,
    `process.on('exit', (c) => console.log('exit', c)); process.on('unhandledRejection', (r, p) => console.log('unhandled', r.message, p instanceof Promise)); Promise.reject(new Error('rej')); setTimeout(() => console.log('timer'), 20);`,
    // A reason that is not an error is wrapped in one.
    `process.on('exit', (c) => console.log('exit', c)); process.on('uncaughtException', (e, origin) => console.log(e.name, e.code, origin, e.message.slice(-24))); Promise.reject(42); setTimeout(() => console.log('timer'), 20);`,
    `process.on('exit', (c) => console.log('exit', c)); Promise.reject(42);`,
    // An AbortError is passed on as it is; an object whose stack it only inherits is wrapped.
    `process.on('uncaughtException', (e, o) => console.log(o, e === r, e.name));
     let r = new DOMException('a', 'AbortError'); Promise.reject(r);
     setTimeout(() => { r = Object.create(new Error('x')); Promise.reject(r); }, 10);`,
    // A throw in the listener is uncaught.
    `process.on('exit', (c) => console.log('exit', c)); process.on('unhandledRejection', (r) => { console.log('unhandled', r.message); throw new Error('again'); }); Promise.reject(new Error('r'));`,
    // Handled before the end of the task: not unhandled. Handled in a later one: too late.
    `process.on('exit', (c) => console.log('exit', c)); const p = Promise.reject(new Error('r')); process.nextTick(() => p.catch(() => console.log('tick catch')));`,
    `process.on('exit', (c) => console.log('exit', c)); const p = Promise.reject(new Error('r')); setTimeout(() => p.catch(() => console.log('late catch')), 10);`,
    `process.on('exit', (c) => console.log('exit', c)); process.on('unhandledRejection', () => console.log('unhandled')); process.on('rejectionHandled', (p) => console.log('rejectionHandled', p instanceof Promise)); const p = Promise.reject(new Error('r')); setTimeout(() => p.catch(() => console.log('late catch')), 10);`,
  ]) outs.push(await ends({ 'main.js': program }));
  assert.deepEqual(outs, [
    { stdout: 'exit 1\n', fatal: 'Error: rej' },
    { stdout: 'unhandled rej true\ntimer\nexit 0\n', exit: 0 },
    { stdout: 'UnhandledPromiseRejection ERR_UNHANDLED_REJECTION unhandledRejection ed with the reason "42".\ntimer\nexit 0\n', exit: 0 },
    { stdout: 'exit 1\n', fatal: 'UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "42".' },
    { stdout: 'unhandledRejection true AbortError\nunhandledRejection false UnhandledPromiseRejection\n', exit: 0 },
    { stdout: 'unhandled r\nexit 1\n', fatal: 'Error: again' },
    { stdout: 'tick catch\nexit 0\n', exit: 0 },
    { stdout: 'exit 1\n', fatal: 'Error: r' },
    { stdout: 'unhandled\nlate catch\nrejectionHandled true\nexit 0\n', exit: 0 },
  ]);
});

/** Which listeners a rejection reaches, and how the process ends, under each --unhandled-rejections mode. */
const MODES = `
  process.on('exit', (c) => console.log('exit', c, process.exitCode));
  process.on('warning', (w) => console.log('warning', w.name));
  process.on('uncaughtExceptionMonitor', (e, o) => console.log('monitor', e.message, o));
  if (process.env.LISTENER === 'ur') process.on('unhandledRejection', (r) => console.log('unhandledRejection', r.message));
  if (process.env.LISTENER === 'ue') process.on('uncaughtException', (e, o) => console.log('uncaughtException', e.message, o));
  Promise.reject(new Error('r'));
  setTimeout(() => console.log('timer'), 20);`;

test('--unhandled-rejections: strict, warn, none and warn-with-error-code, as an option or in NODE_OPTIONS', async () => {
  const got: Record<string, End> = {};
  for (const mode of ['throw', 'strict', 'warn', 'none', 'warn-with-error-code']) {
    for (const listener of ['', 'ur', 'ue']) got[`${mode} ${listener}`] = await ends({ 'main.js': MODES }, '/app/main.js', [`--unhandled-rejections=${mode}`], { LISTENER: listener });
  }
  got.NODE_OPTIONS = await ends({ 'main.js': MODES }, '/app/main.js', [], { LISTENER: '', NODE_OPTIONS: '--unhandled-rejections=none' });
  const warned = 'warning UnhandledPromiseRejectionWarning\nwarning UnhandledPromiseRejectionWarning\n';
  assert.deepEqual(got, {
    'throw ': { stdout: 'monitor r unhandledRejection\nexit 1 1\n', fatal: 'Error: r' },
    'throw ur': { stdout: 'unhandledRejection r\ntimer\nexit 0 undefined\n', exit: 0 },
    'throw ue': { stdout: 'monitor r unhandledRejection\nuncaughtException r unhandledRejection\ntimer\nexit 0 undefined\n', exit: 0 },
    'strict ': { stdout: 'monitor r unhandledRejection\nexit 1 1\n', fatal: 'Error: r' },
    'strict ur': { stdout: 'monitor r unhandledRejection\nexit 1 1\n', fatal: 'Error: r' },
    'strict ue': { stdout: `monitor r unhandledRejection\nuncaughtException r unhandledRejection\n${warned}timer\nexit 0 undefined\n`, exit: 0 },
    'warn ': { stdout: `${warned}timer\nexit 0 undefined\n`, exit: 0 },
    'warn ur': { stdout: `unhandledRejection r\n${warned}timer\nexit 0 undefined\n`, exit: 0 },
    'warn ue': { stdout: `${warned}timer\nexit 0 undefined\n`, exit: 0 },
    'none ': { stdout: 'timer\nexit 0 undefined\n', exit: 0 },
    'none ur': { stdout: 'unhandledRejection r\ntimer\nexit 0 undefined\n', exit: 0 },
    'none ue': { stdout: 'timer\nexit 0 undefined\n', exit: 0 },
    'warn-with-error-code ': { stdout: `${warned}timer\nexit 1 1\n`, exit: 1 },
    'warn-with-error-code ur': { stdout: 'unhandledRejection r\ntimer\nexit 0 undefined\n', exit: 0 },
    'warn-with-error-code ue': { stdout: `${warned}timer\nexit 1 1\n`, exit: 1 },
    NODE_OPTIONS: { stdout: 'timer\nexit 0 undefined\n', exit: 0 },
  });
});

/** Warnings under each of Node's warning options (stdout: the events; stderr: what the process printed). */
const WARNINGS = `
  process.on('warning', (w) => console.log('event', w.name, w.message));
  if (process.env.PROP) process[process.env.PROP] = true;
  process.emitWarning('w1');
  process.emitWarning('d1', 'DeprecationWarning');
  process.emitWarning('d2', { type: 'DeprecationWarning', code: 'DEP0' });
  for (const x of [1, null, {}]) { try { process.emitWarning(x); } catch (e) { console.log(e.code, e.message); } }
  console.log('listeners', process.listenerCount('warning'));`;

test("process.emitWarning emits 'warning' on the next tick, printed by the process's own listener, as --no-warnings, NODE_NO_WARNINGS and the deprecation options have it", async () => {
  const invalid = [
    'ERR_INVALID_ARG_TYPE The "warning" argument must be of type string or an instance of Error. Received type number (1)',
    'ERR_INVALID_ARG_TYPE The "warning" argument must be of type string or an instance of Error. Received null',
    'ERR_INVALID_ARG_TYPE The "warning" argument must be of type string or an instance of Error. Received an instance of Object',
  ].join('\n');
  const events = 'event Warning w1\nevent DeprecationWarning d1\nevent DeprecationWarning d2\n';
  const hint = '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  const runs: Record<string, { stdout: string; stderr: string; exit: number | null; fatal: string | null }> = {};
  for (const [name, execArgv, env] of [
    ['default', [], {}],
    ['--no-warnings', ['--no-warnings'], {}],
    ['NODE_NO_WARNINGS', [], { NODE_NO_WARNINGS: '1' }],
    ['--no-deprecation', ['--no-deprecation'], {}],
    ['process.noDeprecation', [], { PROP: 'noDeprecation' }],
    ['--throw-deprecation', ['--throw-deprecation'], {}],
    ['--trace-deprecation', ['--trace-deprecation'], {}],
    ['--trace-warnings', ['--trace-warnings'], {}],
  ] as [string, string[], Record<string, string>][]) {
    const out = await h.run({ 'main.js': WARNINGS }, '/app/main.js', [], execArgv, { env });
    runs[name] = { stdout: out.stdout, stderr: out.stderr, exit: out.exit, fatal: out.fatal && String(out.fatal).split('\n')[0] };
  }
  const plain = (stderr: string, listeners: number, ev = events) => ({ stdout: `${invalid}\nlisteners ${listeners}\n${ev}`, stderr, exit: 0, fatal: null });
  assert.deepEqual(runs.default, plain(`(node:42) Warning: w1\n${hint}(node:42) DeprecationWarning: d1\n(node:42) [DEP0] DeprecationWarning: d2\n`, 2));
  assert.deepEqual(runs['--no-warnings'], plain('', 1));
  assert.deepEqual(runs.NODE_NO_WARNINGS, plain('', 1));
  assert.deepEqual(runs['--no-deprecation'], plain(`(node:42) Warning: w1\n${hint}`, 2, 'event Warning w1\n'));
  assert.deepEqual(runs['process.noDeprecation'], plain(`(node:42) Warning: w1\n${hint}`, 2, 'event Warning w1\n'));
  // The first deprecation is thrown on the next tick: uncaught.
  assert.deepEqual([runs['--throw-deprecation'].stdout, runs['--throw-deprecation'].fatal], [`${invalid}\nlisteners 2\nevent Warning w1\n`, 'DeprecationWarning: d1']);
  // A traced warning prints its stack, and no hint.
  assert.equal(runs['--trace-deprecation'].stdout, `${invalid}\nlisteners 2\n${events}`);
  assert.match(runs['--trace-deprecation'].stderr, /^\(node:42\) Warning: w1\n\(Use `node --trace-warnings \.\.\.`[^\n]*\n\(node:42\) DeprecationWarning: d1\n {4}at /);
  assert.match(runs['--trace-warnings'].stderr, /^\(node:42\) Warning: w1\n {4}at /);
  assert.ok(!runs['--trace-warnings'].stderr.includes('(Use `node'), runs['--trace-warnings'].stderr);
});

test("signals: SIGBREAK (Windows' Ctrl-Break) is unknown on Linux; one a process sends itself goes to its listeners, or ends it", async () => {
  const out = await h.run(
    {
      'main.js': `
        const t = (f) => { try { return f(); } catch (e) { return e.code; } };
        process.on('SIGBREAK', () => console.log('never'));
        process.on('SIGUSR2', (s, n) => console.log('got', s, n));
        console.log(JSON.stringify([
          process.listenerCount('SIGBREAK'), require('os').constants.signals.SIGBREAK, require('os').constants.signals.SIGUSR2,
          t(() => process.kill(process.pid, 'SIGBREAK')), t(() => process.kill(process.pid, 'sigusr2')), t(() => process.kill(String(process.pid), 0)),
          t(() => process.kill(process.pid, 99)), t(() => process.kill(process.pid, 0)), t(() => process.kill(process.pid, 'SIGUSR2')),
        ]));
        setImmediate(() => console.log('immediate'));
        process.nextTick(() => console.log('tick'));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), ['[1,null,12,"ERR_UNKNOWN_SIGNAL","ERR_UNKNOWN_SIGNAL",true,"EINVAL",true,true]', 'tick', 'got SIGUSR2 12', 'immediate']);
  assert.equal(out.exit, 0);
  const outs = [];
  for (const program of [
    // Signal 0 only probes the child (true while it runs), as in Node.
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
     try { c.kill('SIGBREAK'); } catch (e) { console.log(e.code, e.message); }
     console.log('probe', c.kill(0), c.killed, c.signalCode);
     c.on('exit', (code, signal) => console.log('child exit', code, signal, c.kill(0)));
     c.kill(15);`,
    // Node ends by the signal, at once: a shell sees 143 (128 + 15), and 'exit' is not emitted.
    `process.on('exit', () => console.log('not emitted')); process.nextTick(() => console.log('tick')); process.kill(process.pid, 'SIGTERM'); console.log('after'); setTimeout(() => console.log('not reached'), 50);`,
    // Ignored (SIGWINCH, SIGPIPE), or SIGUSR1, for which Node starts its inspector.
    `process.kill(process.pid, 'SIGWINCH'); process.kill(process.pid, 'SIGPIPE'); process.kill(process.pid, 'SIGUSR1'); setTimeout(() => console.log('still here'), 20);`,
    // Neither a signal's name nor its number.
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
     for (const s of [{}, [1], true, null, '0', 1.5]) { try { c.kill(s); } catch (e) { console.log(e.code, e.message); } }
     c.kill();`,
  ]) {
    const end = await h.run({ 'main.js': program }, '/app/main.js');
    outs.push([end.stdout, end.exit, end.fatal]);
  }
  assert.deepEqual(outs, [
    ['ERR_UNKNOWN_SIGNAL Unknown signal: SIGBREAK\nprobe true true null\nchild exit null SIGTERM false\n', 0, null],
    ['', 143, null],
    ['still here\n', 0, null],
    [['{}', '[ 1 ]', 'true', 'null', '0', '1.5'].map((s) => `ERR_UNKNOWN_SIGNAL Unknown signal: ${s}\n`).join(''), 0, null],
  ]);
});
