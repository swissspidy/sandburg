/** Chromium's launch options (src/orchestrator/launch.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchOptions, playwrightDisabledFeatures } from '../../src/orchestrator/launch.ts';

test("one --disable-features switch: Playwright's features and Sandburg's, in place of Playwright's own", () => {
  const features = playwrightDisabledFeatures();
  // Read from playwright-core: a version that builds its switch otherwise fails here, not silently.
  assert.ok(features && features.includes('AimEnabled') && features.includes('DestroyProfileOnBrowserClose'), JSON.stringify(features));
  const options = launchOptions({});
  const switches = (options.args ?? []).filter((a) => a.startsWith('--disable-features='));
  assert.equal(switches.length, 1);
  const ours = switches[0].slice('--disable-features='.length).split(',');
  for (const f of [...features, 'PreconnectToSearch', 'AutofillServerCommunication']) assert.ok(ours.includes(f), f);
  // Chromium takes the last switch only: Playwright's own is left out, not overridden by position.
  assert.deepEqual(options.ignoreDefaultArgs, [`--disable-features=${features.join(',')}`]);
});
