/**
 * Local packages (src/adapters/node/local-packages.ts, ADR 0064): what npm installs for a monorepo,
 * and for file:/link:/workspace: dependencies, and what is refused before anything is installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { installPlan, planOf } from '../../src/adapters/node/local-packages.ts';
import { assertRegistryLockfile, assertRegistryManifest } from '../../src/adapters/node/spec-guard.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import { browserInstall, devScript, packageDirs, startCommand } from '../../src/adapters/node/plan.ts';
import { node } from '../../src/adapters/node/index.ts';
import type { FileTree, PackageJson } from '../../src/types.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/** A project of package.json files (dir → manifest; '' the root) and other files. */
function files(packages: Record<string, PackageJson>, other: FileTree = {}): { files: FileTree; pkg: PackageJson } {
  const out: FileTree = { ...other };
  for (const [dir, manifest] of Object.entries(packages)) out[dir ? `${dir}/package.json` : 'package.json'] = JSON.stringify(manifest);
  return { files: out, pkg: packages[''] };
}
const plan = (packages: Record<string, PackageJson>, other: FileTree = {}) => {
  const p = files(packages, other);
  return installPlan(p.files, p.pkg);
};
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

test('a project without local packages or another lockfile installs its package.json as it is', () => {
  const pkg: PackageJson = { dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^8.0.0' }, overrides: { a: '1.0.0' } };
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
  const p = installPlan({ 'package.json': JSON.stringify(pkg), 'package-lock.json': lock }, pkg);
  // The same objects: the install's key (a digest of the manifest npm gets) is the one it was.
  assert.equal(p.root.dependencies, pkg.dependencies);
  assert.equal(p.root.devDependencies, pkg.devDependencies);
  assert.equal(p.root.overrides, pkg.overrides);
  assert.equal(p.lockfile, lock);
  assert.deepEqual([p.nested, p.links, p.workspaces, p.pinned, p.local], [[], {}, {}, null, []]);
});

test('npm workspaces: every workspace is linked at the top, its registry dependencies installed with the root', () => {
  const p = plan({
    '': { name: 'mono', workspaces: ['apps/*', 'packages/*'], devDependencies: { typescript: '^5.0.0' } },
    'apps/web': { name: 'web', dependencies: { '@acme/ui': '^1.0.0', express: '^5.0.0' }, devDependencies: { vite: '^8.0.0' } },
    'packages/ui': { name: '@acme/ui', version: '1.2.0', dependencies: { ms: '^2.1.0' } },
    'tools/x': { name: 'not-a-workspace', dependencies: { left: '1.0.0' } },
  });
  assert.deepEqual(p.root.dependencies, { express: '^5.0.0', vite: '^8.0.0', ms: '^2.1.0' });
  assert.deepEqual(p.root.devDependencies, { typescript: '^5.0.0' });
  assert.deepEqual(p.links, { 'node_modules/web': 'apps/web', 'node_modules/@acme/ui': 'packages/ui' });
  assert.deepEqual(p.workspaces, { web: 'apps/web', '@acme/ui': 'packages/ui' });
  assert.deepEqual(p.local, ['apps/web', 'packages/ui']);
  assert.deepEqual(p.nested, []);
  // What npm gets passes the registry-only rule (ADR 0054).
  assert.doesNotThrow(() => assertRegistryManifest(p.root));
});

test('a workspace needing another version of a package than the root gets it in its own node_modules', () => {
  const p = plan({
    '': { name: 'mono', workspaces: ['packages/*'], dependencies: { ms: '^2.1.0', '@acme/old': '*' } },
    'packages/old': { name: '@acme/old', version: '1.0.0', dependencies: { ms: '1.0.0', kleur: '^4.0.0' } },
  });
  assert.deepEqual(p.root.dependencies, { ms: '^2.1.0', kleur: '^4.0.0' });
  assert.deepEqual(p.nested, [{ dir: 'packages/old', dependencies: { ms: '1.0.0' }, lockfile: null }]);
});

test('pnpm workspaces: workspace: ranges (and aliases) link the workspace package of that name', () => {
  const p = plan(
    {
      '': { name: 'mono', dependencies: { '@acme/a': 'workspace:*', b: 'workspace:@acme/b@^1.0.0' } },
      'packages/a': { name: '@acme/a', version: '0.0.0' },
      'packages/b': { name: '@acme/b', version: '1.0.0' },
    },
    { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" },
  );
  assert.deepEqual(p.links, { 'node_modules/@acme/a': 'packages/a', 'node_modules/@acme/b': 'packages/b', 'node_modules/b': 'packages/b' });
  assert.deepEqual(p.root.dependencies, {});
});

test('file: and link: dependencies inside the project are linked; their own dependencies (not their devDependencies) installed', () => {
  const p = plan({
    '': { name: 'app', dependencies: { lib: 'file:./lib', other: 'link:shared/other', react: '^19.0.0' } },
    lib: { name: 'lib', dependencies: { ms: '^2.0.0', deeper: 'file:../deeper' }, devDependencies: { mocha: '^11.0.0' } },
    'shared/other': { name: 'other' },
    deeper: { name: 'deeper', dependencies: { kleur: '^4.0.0' } },
  });
  assert.deepEqual(p.links, { 'node_modules/lib': 'lib', 'node_modules/other': 'shared/other', 'node_modules/deeper': 'deeper' });
  assert.deepEqual(p.root.dependencies, { react: '^19.0.0', ms: '^2.0.0', kleur: '^4.0.0' });
  assert.deepEqual(p.local, ['deeper', 'lib', 'shared/other']);
});

test('a local dependency whose name a registry package already has at the top is linked into its dependent', () => {
  const p = plan({
    '': { name: 'mono', workspaces: ['apps/*'], dependencies: { ms: '^2.0.0' } },
    'apps/web': { name: 'web', dependencies: { ms: 'file:../../vendor/ms' } },
    'vendor/ms': { name: 'ms', version: '0.0.0-local' },
  });
  assert.equal(p.links['node_modules/ms'], undefined);
  assert.equal(p.links['apps/web/node_modules/ms'], 'vendor/ms');
});

test('anything outside the project is refused as unsupported, naming the dependency', () => {
  for (const spec of ['file:../elsewhere', 'link:../../x', 'file:/etc', '../sibling', 'file:~/x', 'file:packages/../../x']) {
    assert.equal(code(() => plan({ '': { name: 'app', dependencies: { evil: spec } }, packages: { name: 'p' } })), 'UNSUPPORTED', spec);
    assert.match(message(() => plan({ '': { name: 'app', dependencies: { evil: spec } } })), new RegExp(`^evil@${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: .*outside the project`));
  }
  // From a workspace too: relative to the workspace, and still bounded by the project.
  assert.equal(code(() => plan({ '': { workspaces: ['apps/*'] }, 'apps/web': { name: 'web', dependencies: { x: 'file:../../../out' } } })), 'UNSUPPORTED');
  // A workspace: path outside, and a local tarball.
  assert.equal(code(() => plan({ '': { workspaces: ['a'], dependencies: { x: 'workspace:../out' } }, a: { name: 'a' } })), 'UNSUPPORTED');
  assert.match(message(() => plan({ '': { dependencies: { t: 'file:./t.tgz' } } })), /^t@file:\.\/t\.tgz: a local tarball dependency/);
});

test('git, URL and user/repo dependencies are refused as unsupported, early, with what they are', () => {
  const cases: [string, RegExp][] = [
    ['git+https://github.com/a/b.git', /a git repository dependency/],
    ['github:a/b', /a git repository dependency/],
    ['git@github.com:a/b.git', /a git repository dependency/],
    ['git@github.com:a/b', /a git repository dependency/],
    ['https://example.com/x.tgz', /a URL dependency/],
    ['user/repo', /a GitHub repository \(user\/repo\) dependency/],
    ['user/repo#main', /a GitHub repository \(user\/repo\) dependency/],
  ];
  for (const [spec, kind] of cases) {
    // In a workspace's dependencies too.
    const project = { '': { name: 'mono', workspaces: ['w'] }, w: { name: 'w', devDependencies: { dep: spec } } };
    assert.equal(code(() => plan(project)), 'UNSUPPORTED', spec);
    assert.match(message(() => plan(project)), new RegExp(`^dep@${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: `), spec);
    assert.match(message(() => plan(project)), kind, spec);
  }
});

test('a local package that is not there is the app\'s mistake', () => {
  assert.equal(code(() => plan({ '': { dependencies: { a: 'workspace:*' } } })), 'APP');
  assert.equal(code(() => plan({ '': { dependencies: { a: 'file:./missing' } } })), 'APP');
  assert.equal(code(() => plan({ '': { workspaces: ['p/*'] }, 'p/a': { name: 'same' }, 'p/b': { name: 'same' } })), 'APP');
  assert.equal(code(() => installPlan({ 'package.json': '{"workspaces":["p"]}', 'p/package.json': '{' }, { workspaces: ['p'] })), 'APP');
});

test("a monorepo's package-lock.json loses its local packages' entries and passes the registry-only check", async () => {
  const project = await loadProject(fixture('monorepo-workspaces'));
  const lock = project.files['package-lock.json'] as string;
  // As npm writes it, it links the workspaces: refused as it is (ADR 0054).
  assert.throws(() => assertRegistryLockfile(lock), (e: unknown) => (e as { code?: string }).code === 'UNSUPPORTED');
  const p = installPlan(project.files, project.packageJson);
  assert.doesNotThrow(() => assertRegistryLockfile(p.lockfile!));
  const packages = JSON.parse(p.lockfile!).packages as Record<string, { version?: string }>;
  assert.deepEqual(Object.keys(packages), ['', 'node_modules/ms']);
  assert.equal(packages['node_modules/ms'].version, '2.1.2');
  assert.deepEqual(p.links, { 'node_modules/web': 'apps/web', 'node_modules/@acme/greet': 'packages/greet', 'node_modules/@acme/format': 'shared/format' });
  // A v2 lockfile's back-compat tree records workspaces as file: versions: it goes too.
  const v2 = { ...JSON.parse(lock), lockfileVersion: 2, dependencies: { web: { version: 'file:apps/web' }, ms: { version: '2.1.2' } } };
  const fromV2 = installPlan({ ...project.files, 'package-lock.json': JSON.stringify(v2) }, project.packageJson);
  assert.doesNotThrow(() => assertRegistryLockfile(fromV2.lockfile!));
  assert.equal(JSON.parse(fromV2.lockfile!).dependencies, undefined);
  // A link the project's lockfile points outside the project keeps it refused.
  const outside = JSON.parse(lock);
  outside.packages['node_modules/evil'] = { resolved: '../evil', link: true };
  const refused = installPlan({ ...project.files, 'package-lock.json': JSON.stringify(outside) }, project.packageJson);
  assert.throws(() => assertRegistryLockfile(refused.lockfile!), (e: unknown) => (e as { code?: string }).code === 'UNSUPPORTED');
});

test('the pnpm fixture: its workspace: and link: packages linked, its versions pinned by pnpm-lock.yaml', async () => {
  const project = await loadProject(fixture('pnpm-lock-app'));
  const p = installPlan(project.files, project.packageJson);
  assert.deepEqual(p.links, { 'node_modules/@acme/util': 'packages/util', 'node_modules/local-lib': 'lib' });
  assert.deepEqual(p.root.dependencies, { ms: '2.0.0', 'escape-html': '1.0.2' });
  assert.equal(p.pinned, 'pnpm-lock.yaml');
});

test('a workspace package runs its own script in its directory; the root keeps its own', async () => {
  const app = await loadProject(fixture('monorepo-workspaces/apps/web'));
  assert.equal(startCommand(app), null);
  assert.equal(devScript(app), 'npm --prefix apps/web run dev');
  assert.deepEqual(node.probe(app), { verdict: 'supported' });
  const root = await loadProject(fixture('monorepo-workspaces'));
  assert.equal(devScript(root), 'npm run dev --workspace=web');
  const mainOnly = { ...projectFromFiles({ 'package.json': '{"workspaces":["a"]}', 'a/package.json': '{"name":"a","main":"srv.js"}' }, { name: 'm', path: 'm' }), app: 'a' };
  assert.equal(devScript(mainOnly), 'cd a && node srv.js');
});

test('the browser install: the plan\'s root, nested installs and links; local packages are not projects of their own', () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'm', scripts: { dev: 'node server.js' }, dependencies: { ms: '^2.1.0', lib: 'file:./lib', '@acme/old': 'workspace:*' } }),
      'pnpm-workspace.yaml': 'packages: [packages/*]\n',
      'packages/old/package.json': JSON.stringify({ name: '@acme/old', dependencies: { ms: '1.0.0' } }),
      'lib/package.json': JSON.stringify({ name: 'lib', dependencies: { kleur: '^4.0.0' } }),
      'server/package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }),
    },
    { name: 'm', path: 'm' },
  );
  // No client/, server/ installs in a monorepo; without workspaces, not for a linked package.
  assert.deepEqual(packageDirs(project), []);
  const plain = projectFromFiles({ 'package.json': '{"dependencies":{"lib":"file:./lib"}}', 'lib/package.json': '{}', 'server/package.json': '{"dependencies":{"x":"1"}}' }, { name: 'p', path: 'p' });
  assert.deepEqual(packageDirs(plain, ['lib']), ['server']);
  const plan = browserInstall(project);
  assert.deepEqual(
    plan.browserInstall?.map((p) => [p.dir, p.packageJson.dependencies]),
    [
      ['', { ms: '^2.1.0', kleur: '^4.0.0' }],
      ['packages/old', { ms: '1.0.0' }],
    ],
  );
  assert.deepEqual(plan.links, { 'node_modules/@acme/old': 'packages/old', 'node_modules/lib': 'lib' });
  assert.deepEqual(plan.workspaces, { '@acme/old': 'packages/old' });
});

test('the probe refuses what cannot be installed before anything is; a missing local package is left to the install', () => {
  const app = (dependencies: Record<string, string>) => projectFromFiles({ 'package.json': JSON.stringify({ scripts: { dev: 'node s.js' }, dependencies }) }, { name: 'a', path: 'a' });
  const probe = node.probe(app({ x: 'github:a/b' }));
  assert.equal(probe.verdict, 'unsupported');
  assert.match((probe as { reason: string }).reason, /^x@github:a\/b: a git repository dependency/);
  assert.equal(node.probe(app({ x: 'file:../out' })).verdict, 'unsupported');
  assert.equal(node.probe(app({ x: 'file:./missing' })).verdict, 'supported');
  assert.equal(node.probe(app({ x: '^1.0.0' })).verdict, 'supported');
});

test('compatible ranges of a package are installed once, at the top; only ranges no one version serves are nested', () => {
  const p = plan({
    '': { name: 'mono', workspaces: ['apps/*', 'packages/*'], dependencies: { react: '^18.2.0' } },
    'apps/web': { name: 'web', dependencies: { react: '^18.3.1', ui: '*' } },
    'packages/ui': { name: 'ui', version: '1.0.0', peerDependencies: { react: '>=18' } },
  });
  assert.deepEqual(p.nested, []);
  assert.equal(p.root.dependencies?.react, '>=18.2.0 <19.0.0-0 >=18.3.1 <19.0.0-0');
  const apart = plan({ '': { workspaces: ['a'], dependencies: { react: '^18.2.0' } }, a: { name: 'a', dependencies: { react: '^19.0.0' } } });
  assert.deepEqual(apart.nested, [{ dir: 'a', dependencies: { react: '^19.0.0' }, lockfile: null }]);
});

test("with a package-lock, a workspace's range the locked version does not serve is nested, at the lock's own nested version", () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['a'] },
      'node_modules/react': { version: '18.2.0', resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz', integrity: 'sha512-r' },
      'node_modules/a': { resolved: 'a', link: true },
      a: { name: 'a', dependencies: { react: '^18.3.0' } },
      'a/node_modules/react': { version: '18.3.1', resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz', integrity: 'sha512-s' },
    },
  });
  const p = installPlan(
    { 'package.json': JSON.stringify({ workspaces: ['a'], dependencies: { react: '^18.2.0' } }), 'a/package.json': JSON.stringify({ name: 'a', dependencies: { react: '^18.3.0' } }), 'package-lock.json': lock },
    { workspaces: ['a'], dependencies: { react: '^18.2.0' } },
  );
  assert.equal(p.root.dependencies?.react, '^18.2.0');
  assert.equal(p.nested.length, 1);
  assert.deepEqual(p.nested[0].dependencies, { react: '^18.3.0' });
  const nestedLock = JSON.parse(p.nested[0].lockfile!);
  assert.equal(nestedLock.packages['node_modules/react'].version, '18.3.1');
  assert.doesNotThrow(() => assertRegistryLockfile(p.nested[0].lockfile!));
});

test("a local package's peer dependencies are installed, as npm 7 and later install them", () => {
  const p = plan({ '': { workspaces: ['ui'], dependencies: { ms: '^2.0.0' } }, ui: { name: 'ui', peerDependencies: { react: '^18.0.0', ms: '*', opt: '^1.0.0' }, peerDependenciesMeta: { opt: { optional: true } } } });
  assert.deepEqual(p.root.dependencies, { ms: '^2.0.0', react: '^18.0.0' });
});

test('names that are not package names are refused: a workspace, or a local dependency', () => {
  assert.match(message(() => plan({ '': { workspaces: ['a'] }, a: { name: '../../.sandburg' } })), /EINVALIDPACKAGENAME/);
  assert.equal(code(() => plan({ '': { workspaces: ['a'] }, a: { name: '../../.sandburg' } })), 'APP');
  assert.equal(code(() => plan({ '': { dependencies: { '../../x': 'file:./lib' } }, lib: { name: 'lib' } })), 'APP');
  assert.equal(code(() => plan({ '': { dependencies: { 'node_modules/../x': 'workspace:*' }, workspaces: ['lib'] }, lib: { name: 'lib' } })), 'APP');
});

test("an npm monorepo's v1 package-lock.json loses its local packages too", () => {
  const lock = JSON.stringify({ lockfileVersion: 1, dependencies: { web: { version: 'file:apps/web' }, lib: { version: 'file:lib', dependencies: { x: { version: '1.0.0' } } }, ms: { version: '2.1.2', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.2.tgz' } } });
  const p = installPlan(
    { 'package.json': '{}', 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { ms: '^2.1.0', lib: 'file:../../lib' } }), 'lib/package.json': '{"name":"lib"}', 'package-lock.json': lock },
    { workspaces: ['apps/*'] },
  );
  assert.doesNotThrow(() => assertRegistryLockfile(p.lockfile!));
  assert.deepEqual(Object.keys(JSON.parse(p.lockfile!).dependencies), ['ms']);
});

test('the plan is worked out once per project', () => {
  const project = projectFromFiles({ 'package.json': '{"workspaces":["a"]}', 'a/package.json': '{"name":"a"}' }, { name: 'p', path: 'p' });
  assert.equal(planOf(project), planOf(project));
});

test('ranges with || share one copy only where a version is in both: the root\'s spec keeps every bound', async () => {
  const semver = (await import('semver')).default;
  const react = ['16.14.0', '17.0.1', '17.0.2', '18.0.0', '18.2.0', '18.3.1', '19.0.0', '19.3.1'];
  for (const [rootRange, wsRange] of [['^18.2.0', '^18.0.0 || ^19.0.0'], ['^18 || ^17', '^17.0.2'], ['^18.0.0 || ^19.0.0', '^18.2.0 || ^17.0.0']]) {
    const p = plan({ '': { workspaces: ['a'], dependencies: { react: rootRange } }, a: { name: 'a', dependencies: { react: wsRange } } });
    assert.deepEqual(p.nested, [], `${rootRange} + ${wsRange}`);
    const combined = p.root.dependencies!.react;
    const picked = semver.maxSatisfying(react, combined)!;
    assert.ok(semver.satisfies(picked, rootRange) && semver.satisfies(picked, wsRange), `${combined} picks ${picked}`);
    assert.doesNotThrow(() => assertRegistryManifest(p.root));
  }
});

test('the combined range has only the pairs of comparator sets that share a version', () => {
  const p = plan({ '': { workspaces: ['a'], dependencies: { react: '^18 || ^17' } }, a: { name: 'a', dependencies: { react: '^17.0.2' } } });
  assert.equal(p.root.dependencies!.react, '>=17.0.0 <18.0.0-0 >=17.0.2 <18.0.0-0');
});

test("names an object has from its prototype are names like any other: constructor, toString, __proto__", () => {
  const p = plan({
    '': { workspaces: ['ws/*'], dependencies: { toString: '^1.0.0', constructor: '*' } },
    'ws/a': { name: 'constructor', version: '1.0.0', dependencies: { valueOf: '^1.0.0', toString: '^1.0.0' }, peerDependencies: { hasOwnProperty: '^1.0.0' } },
  });
  assert.deepEqual(p.workspaces, { constructor: 'ws/a' });
  assert.deepEqual(p.links, { 'node_modules/constructor': 'ws/a' });
  assert.deepEqual(p.root.dependencies, { toString: '^1.0.0', valueOf: '^1.0.0', hasOwnProperty: '^1.0.0' });
  assert.deepEqual(p.nested, []);
  // In a monorepo without a workspace of that name: a registry dependency.
  const registry = plan({ '': { workspaces: ['w'], dependencies: { constructor: '*' } }, w: { name: 'w' } });
  assert.deepEqual(registry.root.dependencies, { constructor: '*' });
  assert.deepEqual(registry.links, { 'node_modules/w': 'w' });
  assert.equal(code(() => plan({ '': { workspaces: ['a'] }, a: { name: '__proto__' } })), 'APP');
  assert.equal(code(() => plan({ '': { dependencies: { constructor: 'workspace:*' } } })), 'APP');
});
