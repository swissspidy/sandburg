/** The command line's options as the session gets them (src/cli.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, sessionOptions } from '../../src/cli.ts';

const options = (...argv: string[]) => {
  const { values, positionals } = parseCommandLine(argv);
  return sessionOptions(values, positionals[0]);
};

test("--no-browser-sandbox turns Chromium's OS sandbox off; without it, the session's default applies", () => {
  assert.equal(options('run', 'app', '--no-browser-sandbox').browserSandbox, false);
  assert.equal(options('batch', 'apps', '--no-browser-sandbox').browserSandbox, false);
  // Unset: SessionOptions' default (on, unless SANDBURG_NO_BROWSER_SANDBOX=1).
  assert.equal(options('run', 'app').browserSandbox, undefined);
  // --browser-sandbox asks for it even where the environment turns it off.
  assert.equal(options('run', 'app', '--browser-sandbox').browserSandbox, true);
  assert.throws(() => parseCommandLine(['run', 'app', '--browser-sandbox=no']));
});

test('open shows its browser; run and batch do unless --headed', () => {
  assert.equal(options('open', 'app').headless, false);
  assert.equal(options('run', 'app').headless, true);
  assert.equal(options('run', 'app', '--headed').headless, false);
});
