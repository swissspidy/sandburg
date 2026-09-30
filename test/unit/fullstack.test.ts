import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandScript, findFullStack, matchProxy, readViteProxy, splitWords } from '../../src/adapters/node/scripts.ts';

const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ scripts, ...extra });

test('splitWords keeps quoted commands together', () => {
  assert.deepEqual(splitWords(`concurrently -n api,web "node server.js" 'vite --port 5173'`), ['concurrently', '-n', 'api,web', 'node server.js', 'vite --port 5173']);
});

test('one package: concurrently with npm: shorthands and node --watch', () => {
  const files = {
    'package.json': pkg({ dev: 'concurrently "npm:server" "npm:client"', server: 'node --watch server/index.js', client: 'vite' }),
    'server/index.js': '',
    'index.html': '',
  };
  assert.deepEqual(findFullStack(files), { frontend: '', backend: { dir: '', main: 'server/index.js', command: 'node --watch server/index.js' }, proxy: [] });
});

test('client/ and server/ packages started from the root with --prefix and cd', () => {
  const files = {
    'package.json': pkg({ dev: 'concurrently -n api,web -c blue,green "npm run dev --prefix server" "cd client && npm run dev"' }),
    'server/package.json': pkg({ dev: 'nodemon --watch src src/index.ts' }),
    'server/src/index.ts': '',
    'client/package.json': pkg({ dev: 'vite' }),
    'client/index.html': '',
    'client/vite.config.ts': "export default { server: { proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true, rewrite: (path) => path.replace(/^\\/api/, '') } } } }",
  };
  const layout = findFullStack(files);
  assert.equal(layout.frontend, 'client');
  assert.deepEqual(layout.backend, { dir: 'server', main: 'src/index.ts', command: 'nodemon --watch src src/index.ts' });
  assert.deepEqual(layout.proxy, [{ prefix: '/api', regex: undefined, port: 4000, strip: '/api' }]);
});

test('npm-run-all / run-p patterns, tsx watch, env assignments', () => {
  const files = {
    'package.json': pkg({ dev: 'run-p dev:*', 'dev:web': 'vite', 'dev:api': 'cross-env PORT=5000 tsx watch api/server.ts' }),
    'api/server.ts': '',
    'index.html': '',
  };
  assert.deepEqual(findFullStack(files).backend, { dir: '', main: 'api/server.ts', command: 'cross-env PORT=5000 tsx watch api/server.ts' });
});

test('a server/ package that the root does not start is still found', () => {
  const files = {
    'package.json': pkg({ dev: 'vite' }),
    'index.html': '',
    'server/package.json': pkg({ start: 'node index.js' }),
    'server/index.js': '',
  };
  assert.deepEqual(findFullStack(files).backend, { dir: 'server', main: 'index.js', command: 'node index.js' });
});

test('a front end without a backend', () => {
  assert.equal(findFullStack({ 'package.json': pkg({ dev: 'vite' }), 'index.html': '' }).backend, null);
});

test('expandScript: sequences run every part', () => {
  const files = { 'package.json': pkg({ seed: 'node seed.js', dev: 'npm run seed && node server.js' }) };
  assert.deepEqual(expandScript(files, '', 'npm run dev').map((l) => l.command), ['node seed.js', 'node server.js']);
});

test('Vite proxy: string and object targets, regex keys, env fallbacks', () => {
  const files = {
    'vite.config.js': `export default defineConfig({
      server: {
        port: 5173,
        proxy: {
          '/api': 'http://localhost:3001',
          "/auth": { target: process.env.API_URL || "http://127.0.0.1:8080", changeOrigin: true },
          '^/files/.*': { target: 'http://localhost:9000' },
          '/cdn': 'https://example.com',
        },
      },
    })`,
  };
  const rules = readViteProxy(files, '');
  assert.deepEqual(rules.map((r) => [r.prefix || r.regex, r.port]), [['/api', 3001], ['/auth', 8080], ['^/files/.*', 9000]]);
  assert.deepEqual(matchProxy(rules, '/api/notes?x=1'), { rule: rules[0], path: '/api/notes?x=1' });
  assert.equal(matchProxy(rules, '/files/a.png')?.rule.port, 9000);
  assert.equal(matchProxy(rules, '/assets/x.js'), null);
});

test('Vite proxy: rewrite strips the prefix', () => {
  const rules = [{ prefix: '/api', port: 4000, strip: '/api' }];
  assert.equal(matchProxy(rules, '/api/users')?.path, '/users');
  assert.equal(matchProxy(rules, '/api')?.path, '/');
});
