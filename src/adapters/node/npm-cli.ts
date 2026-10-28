/**
 * The npm CLI as a command to spawn. On Windows `npm` is `npm.cmd`, a batch file, which Node spawns
 * only through a shell (CVE-2024-27980), and `spawn('npm')` fails with ENOENT: there npm's own
 * script runs on this Node (`node .../npm/bin/npm-cli.js`), as `npm.cmd` runs it. No shell, so no
 * cmd.exe quoting of the arguments.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** The file and arguments that run `npm <args>`. On Windows, throws when no npm-cli.js is found (see npmCliScript). */
export function npmCommand(args: string[], platform = process.platform): [string, string[]] {
  if (platform !== 'win32') return ['npm', args];
  const cli = npmCliScript();
  if (!cli) {
    throw new Error(
      'npm not found: no npm-cli.js at npm_execpath, beside node.exe (node_modules\\npm), or beside an npm.cmd on PATH. ' +
        'Run Sandburg through npm (npm exec, an npm script), set npm_execpath to npm-cli.js, or install npm beside node.exe.',
    );
  }
  return [process.execPath, [cli, ...args]];
}

/**
 * npm's bin/npm-cli.js, the first of these that is there: the one that started this process
 * (npm_execpath, under `npm run` or `npm test`), the one installed beside the node binary (as the
 * Node.js installer and actions/setup-node place it on Windows), and the one beside each npm.cmd (or
 * npm) on PATH, in PATH's order (an npm.cmd shim runs `<its dir>\node_modules\npm\bin\npm-cli.js`).
 * Null where none is.
 */
export function npmCliScript(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, pathDelimiter = delimiter): string | null {
  const cli = (dir: string) => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  // Windows names it Path; process.env finds it either way, a copy of it does not.
  const path = env.PATH ?? env.Path ?? '';
  const onPath = path
    .split(pathDelimiter)
    .filter((dir) => dir && (existsSync(join(dir, 'npm.cmd')) || existsSync(join(dir, 'npm'))))
    .map(cli);
  for (const candidate of [env.npm_execpath, cli(dirname(execPath)), ...onPath]) {
    if (candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}
