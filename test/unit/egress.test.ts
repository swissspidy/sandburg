import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKUMENT_MAX_AGE_MS, isFresh, originMatcher } from '../../src/orchestrator/egress.ts';

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

test('cached npm package documents go stale; tarballs and other files do not', () => {
  const now = 1_000_000_000;
  const old = now - PACKUMENT_MAX_AGE_MS - 1;
  for (const url of ['https://registry.npmjs.org/exsolve', 'https://registry.npmjs.org/@nuxt%2fkit', 'https://registry.npmjs.org/@nuxt/kit']) {
    assert.equal(isFresh(url, old, now), false, url);
    assert.equal(isFresh(url, now - 1000, now), true, url);
  }
  for (const url of ['https://registry.npmjs.org/exsolve/-/exsolve-1.1.3.tgz', 'https://registry.npmjs.org/@nuxt/kit/-/kit-4.0.0.tgz', 'https://esm.sh/react@19']) {
    assert.equal(isFresh(url, 0, now), true, url);
  }
});
