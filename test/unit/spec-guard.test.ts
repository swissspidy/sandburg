import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRegistryLockfile, assertRegistryManifest, isRegistrySpec, UnsupportedDependencyError } from '../../src/adapters/node/spec-guard.ts';

// The host installs an untrusted project's dependencies with npm. A git or directory dependency's
// `prepare` script runs on the host even under --ignore-scripts (pacote prepares git and dir deps).
// So only registry specs are installed; anything with a protocol or a path is refused before npm runs.

test('isRegistrySpec accepts semver ranges, tags and npm: aliases', () => {
  for (const spec of ['^1.2.3', '~1.2', '1.2.3', '1.2.3-beta.1', '*', 'latest', 'next', '>=1 <2', '1 || 2', '1.x', 'X', '', '  ^2.0.0 ', 'npm:left-pad@^1.3.0', 'npm:@scope/pkg@1', 'npm:other', 'npm:string-width@^4.2.0', 'npm:@scope/pkg']) {
    assert.equal(isRegistrySpec(spec), true, spec);
  }
});

test('isRegistrySpec rejects git, file, link, workspace, URLs, shorthands and paths', () => {
  for (const spec of [
    'git+ssh://git@github.com/a/b.git',
    'git+https://github.com/a/b.git#v1',
    'git://github.com/a/b',
    'github:owner/repo',
    'gitlab:owner/repo',
    'bitbucket:owner/repo',
    'gist:id',
    'file:../local',
    'file:./x.tgz',
    'link:../pkg',
    'workspace:*',
    'https://example.com/x.tgz',
    'http://example.com/x.tgz',
    'owner/repo',
    'owner/repo#semver:^1',
    '../local',
    './local',
    '/abs/path',
    '.',
    '..',
    'npm:../escape', // alias range must be a registry range too
    'npm:git+ssh://x',
    'foo.tgz',
    '.tgz',
    'a.tar',
    'b.tar.gz',
    '.jsonfile',
    'npm:b.tgz',
    'npm:.tar.gz',
    'npm:@scope/n.tgz',
  ]) {
    assert.equal(isRegistrySpec(spec), false, spec);
  }
});

test('assertRegistryManifest refuses a git dependency', () => {
  assert.throws(() => assertRegistryManifest({ dependencies: { x: 'git+ssh://git@h/r.git' } }), (e: unknown) => e instanceof UnsupportedDependencyError && e.code === 'UNSUPPORTED');
});

test('assertRegistryManifest refuses git/file in devDependencies and overrides', () => {
  assert.throws(() => assertRegistryManifest({ devDependencies: { x: 'github:a/b' } }), UnsupportedDependencyError);
  assert.throws(() => assertRegistryManifest({ overrides: { x: 'file:../y' } }), UnsupportedDependencyError);
  assert.throws(() => assertRegistryManifest({ overrides: { x: { '.': 'git://h/r', foo: '^1' } } }), UnsupportedDependencyError);
});

test('assertRegistryManifest allows registry manifests, including an override alias and a $-reuse', () => {
  assert.doesNotThrow(() => assertRegistryManifest({ dependencies: { a: '^1.0.0', b: 'npm:c@^2' }, devDependencies: { d: 'latest' }, overrides: { e: '^1', f: { g: '$e' } } }));
});

test('assertRegistryLockfile refuses git/file/link entries in a v3 lockfile', () => {
  assert.throws(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@h/r.git#abc' } } })), UnsupportedDependencyError);
  assert.throws(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { link: true, resolved: '../x' } } })), UnsupportedDependencyError);
  assert.throws(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { resolved: 'file:../x.tgz' } } })), UnsupportedDependencyError);
});

test('assertRegistryLockfile refuses git entries in a v1 lockfile', () => {
  assert.throws(() => assertRegistryLockfile(JSON.stringify({ dependencies: { x: { version: 'git+https://h/r.git#abc', from: 'git+https://h/r.git' } } })), UnsupportedDependencyError);
});

test('assertRegistryLockfile allows an npm: alias version in a v1/v2 tree, but not an alias to a path', () => {
  const alias = { version: 'npm:string-width@4.2.3', resolved: 'https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz', from: 'npm:string-width@^4.2.0' };
  assert.doesNotThrow(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 2, dependencies: { 'string-width-cjs': alias } })));
  assert.throws(() => assertRegistryLockfile(JSON.stringify({ dependencies: { x: { version: 'npm:../x.tgz' } } })), UnsupportedDependencyError);
});

test('assertRegistryLockfile allows a registry lockfile and ignores non-JSON', () => {
  assert.doesNotThrow(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-x' } } })));
  assert.doesNotThrow(() => assertRegistryLockfile('not json at all'));
});

// Property fuzz: isRegistrySpec must never accept a spec that npm's own npm-package-arg classifies as
// anything but a registry version/range/tag or an alias to one. npa is npm's parser, so agreement
// means the allowlist cannot be slipped a git/file/directory/remote spec. (Uses the npm on PATH.)
test('isRegistrySpec never accepts a spec npm-package-arg calls non-registry (fuzz, fixed seed)', async () => {
  const { execSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { realpathSync } = await import('node:fs');
  let npa: { resolve(name: string, spec: string): { type: string; subSpec?: { type: string } } };
  try {
    const root = dirname(dirname(realpathSync(execSync('command -v npm').toString().trim())));
    npa = createRequire(join(root, 'package.json'))(join(root, 'node_modules', 'npm-package-arg'));
  } catch {
    return; // no npm on PATH: skip (covered by the explicit cases above)
  }
  const registryType = (t: string) => t === 'version' || t === 'range' || t === 'tag';
  const parts = ['^', '~', '1', '2', '.', '0', 'x', '*', '|', ' ', '>', '<', '=', '-', '+', 'latest', 'next', 'beta', ':', '/', '\\', 'git+', 'ssh', 'file', 'link', 'http', '://', 'github', 'workspace', 'npm:', '@scope/n', 'a', 'b', '.tgz', '..'];
  let seed = 0x1234;
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c9277b5) + 0x6d2b79f5) | 0) >>> 0) / 4294967296;
  for (let i = 0; i < 50_000; i++) {
    let spec = '';
    const n = Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) spec += parts[Math.floor(rnd() * parts.length)];
    if (!isRegistrySpec(spec)) continue;
    let type: string | null = null;
    let sub: string | undefined;
    try {
      const r = npa.resolve("p", spec.trim());
      type = r.type;
      sub = r.subSpec?.type;
    } catch {
      continue; // npa could not parse it; npm would reject it too, no fetch
    }
    const ok = registryType(type) || (type === 'alias' && (sub === undefined || registryType(sub)));
    assert.ok(ok, `isRegistrySpec accepted ${JSON.stringify(spec)} but npa calls it ${type}${sub ? `/${sub}` : ''}`);
  }
});

test('a path written with backslashes is named a local directory dependency', async () => {
  const { unsupportedDependency } = await import('../../src/adapters/node/spec-guard.ts');
  for (const spec of ['..\\lib', '.\\lib', '~\\x', '\\abs']) assert.match(unsupportedDependency('x', spec).message, /a local directory dependency/, spec);
});
