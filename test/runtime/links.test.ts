/**
 * Local packages in the runtime (src/node-runtime/links.ts, ADR 0064): a workspace package linked
 * into node_modules has its files there, and resolves to its own directory, as through npm's symlink.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

test("a linked package: its files in node_modules, its modules at its own path, its own dependencies from there", async () => {
  const out = await h.run(
    {
      '.sandburg/workspace.json': JSON.stringify({ links: { 'node_modules/@acme/ui': 'packages/ui' }, packages: { '@acme/ui': 'packages/ui' } }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', main: 'index.js' }),
      'packages/ui/index.js': `module.exports = { file: __filename, dep: require('dep'), helper: require('./lib/helper') };`,
      'packages/ui/lib/helper.js': `module.exports = 'helper';`,
      // The package's own version of a dependency, only found from its own directory.
      'packages/ui/node_modules/dep/index.js': `module.exports = 'its own';`,
      'node_modules/dep/index.js': `module.exports = 'the root\\'s';`,
      'main.js': `
        const fs = require('fs');
        const ui = require('@acme/ui');
        console.log(JSON.stringify({
          file: ui.file, dep: ui.dep, helper: ui.helper,
          once: ui === require('/app/packages/ui/index.js'),
          resolved: require.resolve('@acme/ui'),
          real: fs.realpathSync('/app/node_modules/@acme/ui/lib'),
          listed: fs.readdirSync('/app/node_modules/@acme/ui', { recursive: true }).sort(),
          read: fs.readFileSync('/app/node_modules/@acme/ui/lib/helper.js', 'utf8'),
        }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.split('\n')[0]), {
    file: '/app/packages/ui/index.js',
    dep: 'its own',
    helper: 'helper',
    once: true,
    resolved: '/app/packages/ui/index.js',
    real: '/app/packages/ui/lib',
    // Not its node_modules: that stays in its directory.
    listed: ['index.js', 'lib', 'lib/helper.js', 'package.json'],
    read: "module.exports = 'helper';",
  });
});
