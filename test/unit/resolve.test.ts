import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportMap, injectImportMap, lockfileVersions } from '../../src/adapters/almostnode/resolve.ts';

test('import map shares one React across packages', () => {
  const { imports } = buildImportMap({ react: '18.3.1', 'react-dom': '18.3.1', 'lucide-react': '^0.400.0' });
  assert.equal(imports.react, 'https://esm.sh/react@18.3.1');
  assert.equal(imports['react/'], 'https://esm.sh/react@18.3.1/');
  assert.equal(imports['react-dom'], 'https://esm.sh/react-dom@18.3.1?external=react');
  assert.equal(imports['react-dom/'], 'https://esm.sh/react-dom@18.3.1&external=react/');
  assert.equal(imports['lucide-react'], 'https://esm.sh/lucide-react@%5E0.400.0?external=react,react-dom');
});

test('lockfile v3 yields exact versions of top-level packages only', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/react': { version: '18.3.1' },
      'node_modules/@scope/pkg': { version: '1.2.3' },
      'node_modules/react/node_modules/loose-envify': { version: '1.4.0' },
    },
  });
  assert.deepEqual(lockfileVersions(lock), { react: '18.3.1', '@scope/pkg': '1.2.3' });
  assert.equal(lockfileVersions(JSON.stringify({ lockfileVersion: 1, dependencies: {} })), null);
});

test('import map goes first in <head>', () => {
  const html = injectImportMap('<html><head><title>x</title></head></html>', { imports: { a: 'b' } });
  assert.match(html, /<head>\n<script type="importmap">/);
});
