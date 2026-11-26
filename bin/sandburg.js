#!/usr/bin/env node
// In a checkout, Sandburg runs its TypeScript sources directly (Node >= 24 strips types).
// Node does not strip types under node_modules, so an installed copy runs its build (dist/).
import { readFileSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { resolve, sep } from 'node:path';

// V8's code cache for Sandburg's modules and its dependencies (Playwright's: ~0.1 s of every start),
// kept with the rest of its state in .sandburg/ rather than in a temporary directory other users share.
enableCompileCache(process.env.NODE_COMPILE_CACHE || resolve('.sandburg/node-compile-cache'));

process.removeAllListeners('warning');
process.on('warning', (w) => {
  // Checks files may live in projects whose package.json has no "type" field.
  if (w.name !== 'ExperimentalWarning' && w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(w);
});
const installed = import.meta.dirname.split(sep).includes('node_modules');
const args = process.argv.slice(2);
// serve needs no Playwright (ADR 0075): its module is loaded on its own, without the CLI's.
if (args[0] === 'serve') {
  const { serveMain } = await import(installed ? '../dist/serve.js' : '../src/serve.ts');
  process.exit(await serveMain(args.slice(1)));
}
let cli;
try {
  cli = await import(installed ? '../dist/cli.js' : '../src/cli.ts');
} catch (err) {
  // Playwright is an optional peer dependency (ADR 0074): the browser runtime's embedders do without it.
  const missing = err?.code === 'ERR_MODULE_NOT_FOUND' && /'(playwright-core|@playwright\/test)'/.exec(err.message)?.[1];
  if (!missing) throw err;
  const { version, peerDependencies: peers } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const playwright = Object.entries(peers).map(([name, v]) => `${name}@${v}`).join(' ');
  console.error(`error: Sandburg's CLI needs Playwright, which is not installed (${missing}). Run: ${installCommand(version, playwright)}`);
  process.exit(2);
}
process.exitCode = await cli.main(args);

/**
 * What installs Playwright beside this copy of Sandburg. A copy npx runs from its cache does not see
 * packages installed in the project: Sandburg goes into the project with them. A copy installed in a
 * project gets the peers in the same group as Sandburg (a production dependency stays one). A global
 * copy (npm install -g: no package.json beside its node_modules) gets them installed globally too.
 */
function installCommand(version, playwright) {
  const dir = import.meta.dirname;
  if (dir.includes(`${sep}_npx${sep}`)) return `npm install --save-dev sandburg@${version} ${playwright}, then run npx sandburg again`;
  const at = dir.lastIndexOf(`${sep}node_modules${sep}`);
  if (at === -1) return 'npm install'; // a checkout: they are development dependencies
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(dir.slice(0, at), 'package.json'), 'utf8'));
  } catch {
    // No project there: a global install (<prefix>/lib/node_modules, or <prefix>/node_modules on Windows).
    return `npm install --global ${playwright}`;
  }
  return `npm install ${pkg?.dependencies?.sandburg ? '' : '--save-dev '}${playwright}`;
}
