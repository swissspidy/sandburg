/** The runtime's links of local packages (src/node-runtime/links.ts, ADR 0064): only node_modules paths, inside the project. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, safeLinks, setLinks } from '../../src/node-runtime/links.ts';

test('a link must be a package path in a node_modules directory, and its target inside the project', () => {
  const links = safeLinks({
    'node_modules/@acme/ui': 'packages/ui',
    'apps/web/node_modules/lib': 'lib',
    'node_modules/../../.sandburg': 'lib',
    'node_modules/ok/../../x': 'lib',
    'node_modules/.bin': 'lib',
    'src/x': 'lib',
    'node_modules/up': '../outside',
    'node_modules/abs': '/etc',
  });
  assert.deepEqual(links, { 'node_modules/@acme/ui': 'packages/ui', 'apps/web/node_modules/lib': 'lib' });
  setLinks({ 'node_modules/../../evil': 'lib', 'node_modules/ui': 'packages/ui' }, '/app');
  assert.equal(realpath('/app/node_modules/ui/a.js'), '/app/packages/ui/a.js');
  assert.equal(realpath('/evil/a.js'), '/evil/a.js');
  setLinks({}, '/app');
});
