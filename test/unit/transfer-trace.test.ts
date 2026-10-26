/** The transfer tracer (src/transfer-trace.ts): off by default, a line per large transfer and a table at exit when on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MODULE = join(import.meta.dirname, '../../src/transfer-trace.ts');

/** Runs `code` with the tracer imported as `t`, and returns its stderr. */
function run(code: string, env: Record<string, string> = {}): string {
  const script = `const t = await import(${JSON.stringify(MODULE)});\n${code}`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SANDBURG_TRACE_TRANSFERS: '', ...env }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stderr;
}

const TRANSFERS = `
t.traceTransfer({ hop: 'host→page http', what: 'GET /__sandburg/preload/0123456789abcdef01234567/0123456789abcdef', bytes: 1 << 20, encoding: 'binary', ms: 12 });
t.traceTransfer({ hop: 'host→page http', what: 'GET /__sandburg/small', bytes: 100, encoding: 'binary', ms: 1 });
console.log(t.traceConsole('sandburg:transfer ' + JSON.stringify({ hop: 'runtime→page postMessage', what: 'tree', bytes: 2 << 20, encoding: 'base64', ms: 3 })));
console.log(t.traceConsole('an app message'));
`;

test('transfers are traced only when SANDBURG_TRACE_TRANSFERS is set', () => {
  assert.equal(run(TRANSFERS), '');
});

test('large transfers are printed as they happen and in a table at exit, keys elided', () => {
  const err = run(TRANSFERS, { SANDBURG_TRACE_TRANSFERS: '1' });
  assert.match(err, /\[transfer\] host→page http .* 1024 KB binary .* GET \/__sandburg\/preload\/…\/…/);
  assert.match(err, /runtime→page postMessage .* 2048 KB base64/);
  assert.doesNotMatch(err, /small/);
  assert.match(err, /transfers of 64 KB or more \(2\)/);
});

test('a marked page message that is not a well-formed report is not kept (the table at exit formats each)', () => {
  const err = run(`
console.log(t.traceConsole('sandburg:transfer ' + JSON.stringify({ hop: 'x', what: 'y', bytes: 1 << 20, encoding: 'binary', ms: 'slow' })));
console.log(t.traceConsole('sandburg:transfer ' + JSON.stringify({ bytes: 1 << 20 })));
`, { SANDBURG_TRACE_TRANSFERS: '1' });
  assert.doesNotMatch(err, /transfer/);
});
