#!/usr/bin/env node
/**
 * The `sandburg` command an agent gets in a Harbor trial (SandburgEnvironment puts it on PATH).
 * An agent allowed to run `sandburg` may only run its project, as a browser would:
 *
 * - `sandburg run [dir]` and nothing else (`--help` aside);
 * - every path (the project, --checks, --out) inside the trial's project directory: the project
 *   is loaded into the browser and results are written, and the agent would otherwise choose
 *   which files of this machine those are;
 * - packages installed in the browser, checks run in the page (`--checks-in page`: a checks file
 *   the agent wrote is never imported here), and the trials' shared HTTP cache.
 *
 * The verifier runs Sandburg itself (bin/sandburg.js), with the task's checks on the host.
 *
 *   SANDBURG_HOME     Sandburg's repository
 *   SANDBURG_HARBOR_CACHE   the HTTP cache the trials share
 *   SANDBURG_FENCE_ROOT     the project directory (the trial's workdir)
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const refuse = (message) => {
  console.error(`sandburg: ${message}`);
  process.exit(64);
};

const home = process.env.SANDBURG_HOME;
const root = process.env.SANDBURG_FENCE_ROOT;
const cache = process.env.SANDBURG_HARBOR_CACHE;
if (!home || !root || !cache) refuse('SANDBURG_HOME, SANDBURG_FENCE_ROOT and SANDBURG_HARBOR_CACHE must be set');

const OPTIONS = {
  'install-in': { type: 'string' },
  checks: { type: 'string' },
  'checks-in': { type: 'string' },
  out: { type: 'string' },
  ready: { type: 'string' },
  runtime: { type: 'string' },
  'save-files': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
} catch (e) {
  refuse(`${e.message} (here: sandburg run [dir] [--checks file] [--out dir] [--json] [--ready selector] [--save-files regex])`);
}
const { values, positionals } = parsed;
const cli = join(home, 'bin', 'sandburg.js');
const run = (args) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
};

if (values.help && positionals.length === 0) run(['--help']);
else {
  const [command, target = '.', ...rest] = positionals;
  if (command !== 'run') refuse(`only "sandburg run" is available here${command ? `, not "${command}"` : ''}`);
  if (rest.length) refuse(`unexpected arguments: ${rest.join(' ')}`);
  if (values['install-in'] !== undefined && values['install-in'] !== 'browser') refuse('packages are installed in the browser here (--install-in browser)');
  if (values['checks-in'] !== undefined && values['checks-in'] !== 'page') refuse('checks run in the page here (--checks-in page)');

  const fenced = realpathSync(root);
  /** `path`, if it is inside the project directory (following links); otherwise refuses. */
  const inside = (path, what) => {
    const full = resolve(path);
    let real;
    try {
      real = realpathSync(full);
    } catch {
      // Not there yet (an --out directory): its nearest existing parent decides.
      let dir = dirname(full);
      for (;;) {
        try {
          real = join(realpathSync(dir), full.slice(dir.length));
          break;
        } catch {
          if (dirname(dir) === dir) refuse(`${what} ${path} is not inside the project`);
          dir = dirname(dir);
        }
      }
    }
    if (real !== fenced && !real.startsWith(fenced + sep)) refuse(`${what} ${path} is not inside the project (${root})`);
    return full;
  };

  const args = ['run', inside(target, 'the project'), '--install-in', 'browser', '--checks-in', 'page', '--cache', cache];
  if (values.checks !== undefined) args.push('--checks', inside(values.checks, 'the checks file'));
  args.push('--out', inside(values.out ?? join(target, '.sandburg', 'runs'), 'the results directory'));
  if (values.ready !== undefined) args.push('--ready', values.ready);
  if (values.runtime !== undefined) args.push('--runtime', values.runtime);
  if (values['save-files'] !== undefined) args.push('--save-files', values['save-files']);
  if (values.json) args.push('--json');
  run(args);
}
