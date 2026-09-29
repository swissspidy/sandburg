#!/usr/bin/env node
// Sandburg runs its TypeScript sources directly (Node >= 22.18 strips types).
process.removeAllListeners('warning');
process.on('warning', (w) => {
  // Checks files may live in projects whose package.json has no "type" field.
  if (w.name !== 'ExperimentalWarning' && w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(w);
});
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
