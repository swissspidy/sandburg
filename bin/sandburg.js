#!/usr/bin/env node
// Sandburg runs its TypeScript sources directly (Node >= 22.18 strips types).
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
