import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunState, unwrap } from '../../src/orchestrator/run-state.ts';
import { AdapterError } from '../../src/host/types.ts';
import { projectFromFiles } from '../../src/project.ts';

// The errors a run reports have one shape: a phase that fails or times out records a
// SerializedError ({ name, message, code?, stack? }) in its PhaseRecord, and the run's Failure is
// classified from those.
const run = () => new RunState('run-1', projectFromFiles({ 'index.html': '<p>hi</p>' }, { name: 'p', path: '/p' }), { name: 'node', version: '1' }, false, 'chromium', true);

test('a phase that throws records the error with its name, message, code and stack, and rethrows it', async () => {
  const r = run();
  const err = Object.assign(new Error('npm ERR! 404 not found: left-pad'), { code: 'E404' });
  await assert.rejects(r.phase('install', 1000, () => Promise.reject(err)), err);
  const [phase] = r.phases;
  assert.equal(phase.name, 'install');
  assert.equal(phase.status, 'failed');
  assert.deepEqual({ ...phase.error, stack: undefined }, { name: 'Error', message: 'npm ERR! 404 not found: left-pad', code: 'E404', stack: undefined });
  assert.match(phase.error!.stack!, /npm ERR! 404/);
  assert.equal(r.infraError, null);
});

test('what a program throws that is not an Error, or a code that is not a string, is recorded as text', async () => {
  const r = run();
  await assert.rejects(r.phase('start', 1000, () => Promise.reject('exit 1')));
  await assert.rejects(r.phase('ready', 1000, () => Promise.reject(Object.assign(new TypeError('x is not a function'), { code: 42 }))));
  assert.deepEqual(r.phases[0].error, { name: 'Error', message: 'exit 1' });
  assert.equal(r.phases[1].error?.name, 'TypeError');
  assert.equal(r.phases[1].error?.code, undefined);
});

test('a phase past its deadline is a timeout, named PhaseTimeout, and never infra', async () => {
  const r = run();
  await assert.rejects(r.phase('ready', 20, () => new Promise(() => {})), { name: 'PhaseTimeout', message: 'ready did not finish within 20 ms' });
  assert.equal(r.phases[0].status, 'timeout');
  assert.equal(r.phases[0].error?.name, 'PhaseTimeout');
  assert.equal(r.infraError, null);
});

test('an error of the host page (an adapter error over RPC) keeps its name and code', async () => {
  const r = run();
  const error = new AdapterError('UNSUPPORTED', 'native addon');
  await assert.rejects(r.phase('mount', 1000, async () => unwrap({ ok: false, error: { name: error.name, message: error.message, code: error.code, stack: error.stack } })));
  assert.equal(r.phases[0].error?.name, 'AdapterError');
  assert.equal(r.phases[0].error?.code, 'UNSUPPORTED');
  assert.equal(r.phases[0].error?.message, 'native addon');
  assert.equal(unwrap({ ok: true, value: 7 }), 7);
});

test("the browser's failures are infra; the remaining phases are skipped, in order", async () => {
  const r = run();
  await r.phase('probe', 1000, async () => {});
  await assert.rejects(r.phase('load', 1000, () => Promise.reject(new Error('Target page, context or browser has been closed'))));
  assert.deepEqual(r.infraError, { phase: 'load', message: 'Target page, context or browser has been closed' });
  r.skipRemaining();
  assert.deepEqual(
    r.phases.map((p) => [p.name, p.status]),
    [['probe', 'ok'], ['load', 'failed'], ['mount', 'skipped'], ['install', 'skipped'], ['start', 'skipped'], ['ready', 'skipped'], ['checks', 'skipped'], ['dispose', 'skipped']],
  );
});
