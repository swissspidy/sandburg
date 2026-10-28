/**
 * The npm CLI as a command to spawn. On Windows `npm` is `npm.cmd`, a batch file, which Node spawns
 * only through a shell (CVE-2024-27980), and `spawn('npm')` fails with ENOENT: there npm's own
 * script runs on this Node (`node .../npm/bin/npm-cli.js`), as `npm.cmd` runs it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The file and arguments that run `npm <args>`. */
export function npmCommand(args: string[], platform = process.platform): [string, string[]] {
  if (platform !== 'win32') return ['npm', args];
  const cli = npmCliScript();
  return cli ? [process.execPath, [cli, ...args]] : ['npm', args];
}

/**
 * npm's bin/npm-cli.js: the one that started this process (npm_execpath, under `npm run` or `npm
 * test`), else the one installed beside the node binary on Windows (as the Node.js installer and
 * actions/setup-node place it there); null where neither is.
 */
export function npmCliScript(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | null {
  for (const cli of [env.npm_execpath, join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (cli && /npm-cli\.js$/i.test(cli) && existsSync(cli)) return cli;
  }
  return null;
}
