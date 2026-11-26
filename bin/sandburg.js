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
let cli;
try {
  cli = await import(installed ? '../dist/cli.js' : '../src/cli.ts');
} catch (err) {
  // Playwright is an optional peer dependency (ADR 0074): the browser runtime's embedders do without it.
  const missing = err?.code === 'ERR_MODULE_NOT_FOUND' && /'(playwright-core|@playwright\/test)'/.exec(err.message)?.[1];
  if (!missing) throw err;
  const { version, peerDependencies: peers } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Sandburg too: run by npx from its cache, it would not find peers installed in the project.
  const packages = [`sandburg@${version}`, ...Object.entries(peers).map(([name, v]) => `${name}@${v}`)].join(' ');
  console.error(`error: Sandburg's CLI needs Playwright, which is not installed (${missing}). Run: npm install --save-dev ${packages}`);
  process.exit(2);
}
process.exitCode = await cli.main(process.argv.slice(2));
