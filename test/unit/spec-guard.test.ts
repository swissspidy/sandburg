import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRegistryLockfile, assertRegistryManifest, isRegistrySpec, UnsupportedDependencyError } from '../../src/adapters/node/spec-guard.ts';

// The host installs an untrusted project's dependencies with npm. A git or directory dependency's
// `prepare` script runs on the host even under --ignore-scripts (pacote prepares git and dir deps).
// So only registry specs are installed; anything with a protocol or a path is refused before npm runs.

test('isRegistrySpec accepts semver ranges, tags and npm: aliases', () => {
  for (const spec of ['^1.2.3', '~1.2', '1.2.3', '1.2.3-beta.1', '*', 'latest', 'next', '>=1 <2', '1 || 2', '1.x', 'X', '', '  ^2.0.0 ', 'npm:left-pad@^1.3.0', 'npm:@scope/pkg@1', 'npm:other']) {
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

test('assertRegistryLockfile allows a registry lockfile and ignores non-JSON', () => {
  assert.doesNotThrow(() => assertRegistryLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-x' } } })));
  assert.doesNotThrow(() => assertRegistryLockfile('not json at all'));
});
