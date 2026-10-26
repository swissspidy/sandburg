/** Chromium's launch options (src/orchestrator/launch.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSetupError, browserSandbox, launchOptions, playwrightDisabledFeatures, sandboxUnavailable } from '../../src/orchestrator/launch.ts';

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
  assert.deepEqual(options.ignoreDefaultArgs, ['--enable-unsafe-swiftshader', `--disable-features=${features.join(',')}`]);
});

test("Chromium runs inside its OS sandbox unless turned off, by the option or SANDBURG_NO_BROWSER_SANDBOX=1", (t) => {
  const saved = process.env.SANDBURG_NO_BROWSER_SANDBOX;
  t.after(() => (saved === undefined ? delete process.env.SANDBURG_NO_BROWSER_SANDBOX : (process.env.SANDBURG_NO_BROWSER_SANDBOX = saved)));
  delete process.env.SANDBURG_NO_BROWSER_SANDBOX;
  assert.equal(browserSandbox({}), true);
  assert.equal(launchOptions({}).chromiumSandbox, true);
  assert.equal(launchOptions({ browserSandbox: false }).chromiumSandbox, false);
  // Only 1 turns it off: anything else (a typo, "true") leaves it on.
  for (const value of ['0', '', 'true', 'yes']) {
    process.env.SANDBURG_NO_BROWSER_SANDBOX = value;
    assert.equal(launchOptions({}).chromiumSandbox, true, value);
  }
  process.env.SANDBURG_NO_BROWSER_SANDBOX = '1';
  assert.equal(launchOptions({}).chromiumSandbox, false);
  // The option wins over the environment, either way.
  assert.equal(launchOptions({ browserSandbox: true }).chromiumSandbox, true);
});

test('every site in a process of its own, and without the SwiftShader fallback for web content', () => {
  const options = launchOptions({});
  assert.ok(options.args?.includes('--site-per-process'));
  assert.ok(Array.isArray(options.ignoreDefaultArgs) && options.ignoreDefaultArgs.includes('--enable-unsafe-swiftshader'));
  assert.ok(!options.args?.includes('--no-sandbox'));
});

test("a sandbox that cannot start fails the launch with the opt-out to use; other launch errors are left as they are", () => {
  // Playwright's message when Chromium reports no usable sandbox (its doRewriteStartupLog).
  const playwright = new Error("browserType.launch: Target page, context or browser has been closed\nBrowser logs:\nChromium sandboxing failed!\n================================\nTo avoid the sandboxing issue, do either of the following:");
  for (const err of [playwright, new Error('[pid=1][err] No usable sandbox! If you are running on Ubuntu 23.10+ ...'), new Error('see crbug.com/638180')]) {
    const advice = sandboxUnavailable(err);
    assert.ok(advice, err.message);
    assert.match(advice.message, /--no-browser-sandbox/);
    assert.match(advice.message, /SANDBURG_NO_BROWSER_SANDBOX=1/);
    assert.match(advice.message, /browserSandbox: false/);
    assert.match(advice.message, /apparmor_restrict_unprivileged_userns/);
    assert.equal(advice.cause, err);
    // The CLI prints such an error's message alone, and exits 2.
    assert.ok(advice instanceof BrowserSetupError);
  }
  assert.equal(sandboxUnavailable(new Error("Executable doesn't exist at /x/chrome")), null);
  assert.equal(sandboxUnavailable('Chromium sandboxing failed!'), null);
});
