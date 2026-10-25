import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Installer } from '../../src/adapters/node/install.ts';
import type { Project } from '../../src/types.ts';

// The host installs an untrusted project's dependencies with npm, which (through pacote) prepares git
// and directory dependencies on the host even under --ignore-scripts. install() refuses anything but a
// registry dependency before npm runs, so no such fetch or preparation happens. These tests reach the
// refusal before npm or the network; a registry install is covered by the e2e suites.

function project(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): Project {
  return { files: {}, packageJson: { dependencies, ...extra } } as unknown as Project;
}

test('install() refuses a git, file or URL dependency as unsupported and installs nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-install-specs-'));
  const inst = new Installer(join(root, 'installs'));
  for (const spec of ['git+ssh://git@example.invalid/a/b.git', 'github:a/b', 'file:../x', 'https://example.invalid/x.tgz', 'link:../p']) {
    await assert.rejects(
      async () => inst.install(project({ x: spec }), {}, () => {}),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'UNSUPPORTED',
      spec,
    );
  }
  // Nothing was written: the refusal is before npm resolves or unpacks.
  assert.ok(!existsSync(join(root, 'installs')) || readdirSync(join(root, 'installs')).length === 0);
});

test('install() refuses a project lockfile that installs a non-registry package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-install-lock-'));
  const inst = new Installer(join(root, 'installs'));
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@example.invalid/a/b.git#abc' } } });
  await assert.rejects(
    async () => inst.install({ files: { 'package-lock.json': lock }, packageJson: { dependencies: { x: '^1.0.0' } } } as unknown as Project, {}, () => {}),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'UNSUPPORTED',
  );
});
