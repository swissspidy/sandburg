import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originMatcher } from '../../src/orchestrator/egress.ts';

test('origin allowlist supports exact and wildcard origins', () => {
  const allowed = originMatcher(['https://esm.sh', 'https://*.example.org']);
  assert.ok(allowed('https://esm.sh'));
  assert.ok(allowed('https://abc-3000.cdn.example.org'));
  assert.ok(!allowed('https://example.org'), 'wildcard does not match the apex');
  assert.ok(!allowed('http://x.example.org'), 'scheme must match');
  assert.ok(!allowed('https://x.example.org:8443'), 'no custom ports');
  assert.ok(!allowed('https://evilexample.org'));
  assert.ok(!allowed('https://esm.sh.evil.com'));
  assert.ok(!allowed('http://esm.sh'));
});
