#!/usr/bin/env node
// In a checkout, Sandburg runs its TypeScript sources directly (Node >= 22.18 strips types).
// Node does not strip types under node_modules, so an installed copy runs its build (dist/).
import { sep } from 'node:path';

process.removeAllListeners('warning');
process.on('warning', (w) => {
  // Checks files may live in projects whose package.json has no "type" field.
  if (w.name !== 'ExperimentalWarning' && w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(w);
});
const installed = import.meta.dirname.split(sep).includes('node_modules');
const { main } = await import(installed ? '../dist/cli.js' : '../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
