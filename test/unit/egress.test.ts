import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originMatcher } from '../../src/orchestrator/egress.ts';

test('origin allowlist supports exact and wildcard origins', () => {
  const allowed = originMatcher(['https://esm.sh', 'https://*.codesandbox.io']);
  assert.ok(allowed('https://esm.sh'));
  assert.ok(allowed('https://abc-3000.nodebox.codesandbox.io'));
  assert.ok(!allowed('https://codesandbox.io'), 'wildcard does not match the apex');
  assert.ok(!allowed('http://x.codesandbox.io'), 'scheme must match');
  assert.ok(!allowed('https://x.codesandbox.io:8443'), 'no custom ports');
  assert.ok(!allowed('https://evilcodesandbox.io'));
  assert.ok(!allowed('https://esm.sh.evil.com'));
  assert.ok(!allowed('http://esm.sh'));
});
