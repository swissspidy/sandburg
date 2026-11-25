/**
 * Git dependencies (ADR 0073): which specs the host fetches (git-spec.ts), and the fetch itself
 * (git-packages.ts) against a fake GitHub: the ref resolved with one ls-refs listing, the commit's
 * archive downloaded once and kept on disk, the lockfile's commit used without asking, redirects
 * kept on the repository's host, and what a missing repository or branch is.
 */
import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseGitSpec, looksLikeGit } from '../../src/adapters/node/git-spec.ts';
import { gitLimits, withGitPackages } from '../../src/adapters/node/git-packages.ts';
import { planOf } from '../../src/adapters/node/local-packages.ts';
import { node } from '../../src/adapters/node/index.ts';
import { browserInstall, linkedBin } from '../../src/adapters/node/plan.ts';
import { projectFromFiles } from '../../src/project.ts';
import { classify } from '../../src/classify.ts';
import { tempDir } from './temp-dir.ts';
import type { FileTree, PackageJson } from '../../src/types.ts';

test('the git shapes npm takes for GitHub, GitLab and Bitbucket, as one repository and committish', () => {
  const gh = { host: 'github', origin: 'https://github.com', path: 'user/repo', url: 'https://github.com/user/repo.git', subdir: '' };
  const cases: [string, object][] = [
    ['user/repo', { ...gh, committish: null, semver: null }],
    ['user/repo#main', { ...gh, committish: 'main', semver: null }],
    ['github:user/repo#v1.2.3', { ...gh, committish: 'v1.2.3', semver: null }],
    ['git+https://github.com/user/repo.git', { ...gh, committish: null, semver: null }],
    ['https://github.com/user/repo.git#semver:^1.0', { ...gh, committish: null, semver: '^1.0' }],
    ['git+ssh://git@github.com/user/repo.git#feature/x', { ...gh, committish: 'feature/x', semver: null }],
    ['git@github.com:user/repo.git', { ...gh, committish: null, semver: null }],
    ['git://github.com/user/repo', { ...gh, committish: null, semver: null }],
    ['github:user/repo#main::path:packages/core', { ...gh, committish: 'main', semver: null, subdir: 'packages/core' }],
    ['gitlab:group/sub/repo', { host: 'gitlab', origin: 'https://gitlab.com', path: 'group/sub/repo', url: 'https://gitlab.com/group/sub/repo.git', committish: null, semver: null, subdir: '' }],
    ['bitbucket:team/repo#0123456789abcdef0123456789abcdef01234567', { host: 'bitbucket', origin: 'https://bitbucket.org', path: 'team/repo', url: 'https://bitbucket.org/team/repo.git', committish: '0123456789abcdef0123456789abcdef01234567', semver: null, subdir: '' }],
  ];
  for (const [spec, want] of cases) assert.deepEqual(parseGitSpec(spec), want, spec);
  // Not git at all: registry specs, aliases, paths, URLs to tarballs.
  for (const spec of ['^1.0.0', 'latest', 'npm:x@^1', '../lib', './a/b', 'file:a/b', '~/x/y', 'https://example.com/x.tgz', 'workspace:*']) {
    assert.equal(parseGitSpec(spec), null, spec);
    assert.equal(looksLikeGit(spec), false, spec);
  }
  // git, but not fetched: anything that would make the host reach another host, or read a path.
  for (const spec of ['gist:abc', 'git+ssh://git@internal.example/a/b.git', 'git+https://169.254.169.254/a/b.git', 'git+file:///repo.git', 'git+https://u:p@github.com/a/b.git', 'github:a/../b', 'github:a/b#main::path:../..', 'github:a/b#$(x)']) {
    const parsed = parseGitSpec(spec);
    assert.ok(parsed && 'unsupported' in parsed, spec);
  }
  // A host the deployment lists, over HTTPS.
  assert.equal((parseGitSpec('git+https://git.example.com/a/b.git', ['git.example.com']) as { host: string }).host, 'other');
});

// A fake GitHub: the repository user/lib at two commits, its branch, tag and default branch.
const SHA = { main: 'a'.repeat(40), tag: 'b'.repeat(40), tagObject: 'c'.repeat(40) };

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** A gzipped tar of `files`, under a top directory as GitHub's archives have one. */
function tarball(files: Record<string, string>, top: string): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`${top}/${path}`, 0, 100);
    header.write('0000644\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

const lib = (version: string): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'lib', version, main: 'index.js', dependencies: { ms: '^2.1.0' }, devDependencies: { typescript: '*' } }),
  'index.js': `module.exports = '${version}';`,
  '.git/config': 'not part of the package',
});

let requests: string[] = [];
function fakeGitHub(overrides: Record<string, () => Response> = {}) {
  requests = [];
  return mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (overrides[url]) return overrides[url]();
    if (url === 'https://github.com/user/lib.git/info/refs?service=git-upload-pack') {
      return new Response(`${pkt('# service=git-upload-pack\n')}0000${pkt('version 2\n')}${pkt('ls-refs=unborn\n')}${pkt('fetch=shallow\n')}${pkt('object-format=sha1\n')}0000`);
    }
    if (url === 'https://github.com/user/lib.git/git-upload-pack') {
      const prefix = (/ref-prefix (\S+)/.exec(Buffer.from(init!.body as Uint8Array).toString())?.[1] ?? '').replace(/0000$/, '');
      const refs = [`${SHA.main} HEAD symref-target:refs/heads/main`, `${SHA.main} refs/heads/main`, `${SHA.tagObject} refs/tags/v1.0.0 peeled:${SHA.tag}`];
      return new Response(`${refs.filter((r) => r.split(' ')[1].startsWith(prefix)).map((r) => pkt(`${r}\n`)).join('')}0000`);
    }
    if (url === `https://codeload.github.com/user/lib/tar.gz/${SHA.main}`) return new Response(tarball(lib('2.0.0'), `lib-${SHA.main}`));
    if (url === `https://codeload.github.com/user/lib/tar.gz/${SHA.tag}`) return new Response(tarball(lib('1.0.0'), `lib-${SHA.tag}`));
    return new Response('Not Found', { status: 404 });
  });
}
afterEach(() => mock.restoreAll());

const project = (dependencies: Record<string, string>, other: FileTree = {}, extra: PackageJson = {}) =>
  projectFromFiles({ 'package.json': JSON.stringify({ name: 'app', scripts: { dev: 'node s.js' }, dependencies, ...extra }), ...other }, { name: 'app', path: 'app' });

test('a git dependency is fetched once into .sandburg/git/ and linked; its registry dependencies installed with the root\'s', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  fakeGitHub();
  const lines: string[] = [];
  const p = await withGitPackages(project({ lib: 'github:user/lib' }), { log: (l) => lines.push(l) });
  const dir = `.sandburg/git/github.com-user-lib-${SHA.main.slice(0, 12)}`;
  assert.equal(p.files[`${dir}/index.js`], "module.exports = '2.0.0';");
  assert.equal(p.files[`${dir}/.git/config`], undefined);
  assert.deepEqual(JSON.parse(p.files['.sandburg/git.json'] as string), { 'github:user/lib': dir });
  const plan = planOf(p);
  assert.deepEqual(plan.links, { 'node_modules/lib': dir });
  assert.deepEqual(plan.root.dependencies, { ms: '^2.1.0' });
  assert.match(lines[0], /^git: lib@github:user\/lib → aaaaaaaaaaaa \(2 files, \d+ ms\)$/);
  // Discovery, ls-refs, the archive.
  assert.equal(requests.length, 3);
  // Again: the ref is known for a while, the files are on disk; nothing is asked.
  requests = [];
  await withGitPackages(project({ lib: 'github:user/lib' }));
  assert.deepEqual(requests, []);
});

test('a tag resolves to its commit; semver: to the highest tag in its range; a lockfile\'s commit needs no listing', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  fakeGitHub();
  const tag = await withGitPackages(project({ lib: 'user/lib#v1.0.0' }));
  assert.equal(tag.files[`.sandburg/git/github.com-user-lib-${SHA.tag.slice(0, 12)}/index.js`], "module.exports = '1.0.0';");
  const range = await withGitPackages(project({ lib: 'git+ssh://git@github.com/user/lib.git#semver:^1' }));
  assert.ok(range.files[`.sandburg/git/github.com-user-lib-${SHA.tag.slice(0, 12)}/index.js`]);

  fakeGitHub();
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lib': { version: '1.0.0', resolved: `git+ssh://git@github.com/user/lib.git#${SHA.tag}` } } });
  const locked = await withGitPackages(project({ lib: 'github:user/lib#some-branch' }, { 'package-lock.json': lock }));
  assert.ok(locked.files[`.sandburg/git/github.com-user-lib-${SHA.tag.slice(0, 12)}/index.js`]);
  assert.ok(!requests.some((r) => r.includes('upload-pack')), requests.join('\n'));
  // The lockfile's entry is npm's clone: dropped, so the registry-only check passes.
  assert.doesNotThrow(() => planOf(locked));
});

test('a repository, branch or commit that is not there is the app\'s (unresolvable-dependency); offline, what is not cached fails', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  fakeGitHub();
  const failure = async (spec: string) => withGitPackages(project({ x: spec })).then(() => assert.fail(spec), (e: Error & { code?: string }) => e);
  for (const [spec, message] of [
    ['github:user/missing', /^git: x@github:user\/missing: repository not found \(HTTP 404\)/],
    ['github:user/lib#nope', /^git: x@github:user\/lib#nope: no branch or tag named "nope"/],
    ['github:user/lib#semver:^9', /^git: x@github:user\/lib#semver:\^9: no tag in semver:\^9/],
    [`github:user/lib#${'d'.repeat(40)}`, /^git: x@github:user\/lib#d+: commit d{40} not found/],
  ] as const) {
    const e = await failure(spec);
    assert.match(e.message, message);
    assert.equal(e.code, 'APP');
    const f = classify({ probe: { verdict: 'supported' }, phases: [{ name: 'install', status: 'failed', durationMs: 1, error: { name: e.name, message: e.message, code: e.code } }], checks: [], pageErrors: [], declaredDependencies: [], infraError: null });
    assert.deepEqual([f?.class, f?.rule], ['app-bug', 'unresolvable-dependency'], spec);
  }
  const offline = await withGitPackages(project({ x: 'github:user/lib#other' }), { offline: true }).catch((e: Error) => e);
  assert.match((offline as Error).message, /offline/);
});

test('the host fetches from the repository\'s host only: a redirect elsewhere is refused', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  // A commit no other test fetched (the process keeps what it fetched).
  const sha = 'e'.repeat(40);
  fakeGitHub({ [`https://codeload.github.com/user/lib/tar.gz/${sha}`]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) });
  const e = await withGitPackages(project({ lib: `github:user/lib#${sha}` })).catch((err: Error) => err);
  assert.match((e as Error).message, /refused to fetch http:\/\/169\.254\.169\.254/);
  assert.ok(!requests.some((r) => r.includes('169.254')));
});

test('the node adapter fetches git dependencies as the project\'s sources; a project without any is itself', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  fakeGitHub();
  const plain = project({ ms: '^2.0.0' });
  assert.equal(await node.sources!(plain, { log: () => {} }), plain);
  assert.deepEqual(requests, []);
  const fetched = await node.sources!(project({ lib: 'github:user/lib' }), { log: () => {} });
  assert.deepEqual(planOf(fetched).git, []);
  // The probe takes it; a client/ or server/ package installed on its own does not get one.
  assert.equal(node.probe(project({ lib: 'github:user/lib' })).verdict, 'supported');
  const split = projectFromFiles({ 'package.json': JSON.stringify({ scripts: { dev: 'node server/s.js' } }), 'server/package.json': JSON.stringify({ dependencies: { lib: 'github:user/lib' } }) }, { name: 's', path: 's' });
  assert.equal(node.probe(split).verdict, 'unsupported');
});

test('one fetch per spec, however many packages name it; the root\'s lockfile commit applies to all, and to a semver: range it is in', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  fakeGitHub();
  const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lib': { version, resolved: `git+ssh://git@github.com/user/lib.git#${SHA.tag}` } } });
  const mono = (spec: string, version: string) =>
    projectFromFiles(
      {
        'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'], dependencies: { lib: spec } }),
        'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { lib: spec } }),
        'packages/b/package.json': JSON.stringify({ name: 'b', dependencies: { lib: spec } }),
        'package-lock.json': lock(version),
      },
      { name: 'mono', path: 'mono' },
    );
  const lines: string[] = [];
  const p = await withGitPackages(mono('github:user/lib#main', '1.0.0'), { log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(p.files['.sandburg/git.json'] as string), { 'github:user/lib#main': `.sandburg/git/github.com-user-lib-${SHA.tag.slice(0, 12)}` });
  assert.ok(!requests.some((r) => r.includes('upload-pack')), requests.join('\n'));
  // semver: the locked version is in the range: its commit, no listing.
  requests = [];
  const inRange = await withGitPackages(mono('github:user/lib#semver:^1', '1.0.0'));
  assert.ok(inRange.files[`.sandburg/git/github.com-user-lib-${SHA.tag.slice(0, 12)}/package.json`]);
  assert.ok(!requests.some((r) => r.includes('upload-pack')), requests.join('\n'));
  // Not in the range: resolved from the tags.
  requests = [];
  await withGitPackages(mono('github:user/lib#semver:^2', '1.0.0')).catch(() => {});
  assert.ok(requests.some((r) => r.includes('upload-pack')), requests.join('\n'));
});

test('an archive larger than a repository may be is refused before it is read', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  const sha = 'f'.repeat(40);
  fakeGitHub({ [`https://codeload.github.com/user/lib/tar.gz/${sha}`]: () => new Response('x', { headers: { 'content-length': String(2 ** 40) } }) });
  const e = await withGitPackages(project({ lib: `github:user/lib#${sha}` })).catch((err: Error & { code?: string }) => err);
  assert.match((e as Error).message, /too large to fetch/);
  assert.equal((e as { code?: string }).code, 'UNSUPPORTED');
});

test('a dev script that runs a git package\'s binary starts it from the package\'s linked files', async () => {
  const dir = '.sandburg/git/github.com-user-tool-0123456789ab';
  const p = projectFromFiles({ 'package.json': JSON.stringify({ scripts: { dev: 'tool --port 3000' }, dependencies: { tool: 'github:user/tool' } }) }, { name: 't', path: 't' });
  const fetched = { ...p, files: { ...p.files, [`${dir}/package.json`]: JSON.stringify({ name: 'tool', bin: { tool: './bin/tool.js' } }), [`${dir}/bin/tool.js`]: '', '.sandburg/git.json': JSON.stringify({ 'github:user/tool': dir }) } };
  const plan = planOf(fetched);
  assert.equal(linkedBin(fetched, plan, 'tool'), 'node_modules/tool/bin/tool.js');
  assert.equal(linkedBin(fetched, plan, 'other'), null);
  assert.deepEqual(browserInstall(fetched).start, { main: 'node_modules/tool/bin/tool.js', argv: ['--port', '3000'], command: 'tool --port 3000', tsRunner: false });
});

test('a fetch the run gave up on rejects at once with the run\'s reason, and the fetch itself is kept for others', async () => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sha = '1'.repeat(40);
  fakeGitHub();
  // The archive answers only once released: the run gives up first.
  const fake = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes(sha)) {
      await held;
      return new Response(tarball(lib('3.0.0'), `lib-${sha}`));
    }
    return fake(input, init);
  });
  const controller = new AbortController();
  const pending = withGitPackages(project({ lib: `github:user/lib#${sha}` }), { signal: controller.signal });
  controller.abort(new Error('the run gave up'));
  await assert.rejects(pending, /the run gave up/);
  release();
  // Another run gets the same commit's files from the fetch that went on.
  const again = await withGitPackages(project({ lib: `github:user/lib#${sha}` }));
  assert.equal(again.files[`.sandburg/git/github.com-user-lib-${sha.slice(0, 12)}/index.js`], "module.exports = '3.0.0';");
});

test('responses count against the limits as they arrive: parallel archives together, and a git protocol response on its own', async (t) => {
  process.env.SANDBURG_GIT_DIR = tempDir('sandburg-git-');
  const saved = { ...gitLimits };
  t.after(() => Object.assign(gitLimits, saved));
  // Two archives, each within a repository's limit, over the project's together.
  const [a, b] = ['2'.repeat(40), '3'.repeat(40)];
  const archive = (sha: string) => () => new Response(tarball(lib('4.0.0'), `lib-${sha}`));
  fakeGitHub({ [`https://codeload.github.com/user/lib/tar.gz/${a}`]: archive(a), [`https://codeload.github.com/user/lib/tar.gz/${b}`]: archive(b) });
  const size = tarball(lib('4.0.0'), `lib-${a}`).length;
  Object.assign(gitLimits, { bytes: 100_000, totalBytes: size + size / 2 });
  const together = await withGitPackages(project({ x: `github:user/lib#${a}`, y: `github:user/lib#${b}` })).catch((e: Error) => e);
  assert.match((together as Error).message, /too large together \(over .* MB received\)/);
  // A git protocol response (here the ref listing) larger than a repository may be.
  Object.assign(gitLimits, saved, { bytes: 50 });
  const listing = await withGitPackages(project({ z: 'github:user/lib#a-branch' })).catch((e: Error & { code?: string }) => e);
  assert.match((listing as Error).message, /too large to fetch \(a response over/);
  assert.equal((listing as { code?: string }).code, 'UNSUPPORTED');
  // Ref listings count into the project's budget too, from parallel resolutions together.
  fakeGitHub();
  Object.assign(gitLimits, saved, { totalBytes: 300 });
  const refs = await withGitPackages(project({ p: 'github:user/lib#feature-a', q: 'github:user/lib#feature-b' })).catch((e: Error) => e);
  assert.match((refs as Error).message, /too large together \(over .* MB received\)/);
  // A clone's protocol responses (another host, no archive) are bounded as an archive is.
  process.env.SANDBURG_GIT_HOSTS = 'git.example.com';
  t.after(() => delete process.env.SANDBURG_GIT_HOSTS);
  const discovery = `${pkt('# service=git-upload-pack\n')}0000${pkt('version 2\n')}${pkt('ls-refs=unborn\n')}${pkt('fetch=shallow\n')}${pkt('object-format=sha1\n')}0000`;
  fakeGitHub({ 'https://git.example.com/a/b.git/info/refs?service=git-upload-pack': () => new Response(discovery) });
  Object.assign(gitLimits, saved, { bytes: discovery.length - 1 });
  const clone = await withGitPackages(project({ r: `git+https://git.example.com/a/b.git#${'5'.repeat(40)}` })).catch((e: Error & { code?: string }) => e);
  assert.match((clone as Error).message, /too large to fetch \(a response over/);
  assert.equal((clone as { code?: string }).code, 'UNSUPPORTED');
  assert.ok(requests.some((r) => r.startsWith('GET https://git.example.com/')), requests.join('\n'));
  // An archive that unpacks to more than a repository may: Sandburg's refusal, not zlib's.
  const c = '4'.repeat(40);
  Object.assign(gitLimits, saved, { bytes: size + 10 });
  fakeGitHub({ [`https://codeload.github.com/user/lib/tar.gz/${c}`]: archive(c) });
  const unpacked = await withGitPackages(project({ w: `github:user/lib#${c}` })).catch((e: Error) => e);
  assert.match((unpacked as Error).message, /too large to fetch \(over .* MB unpacked\)/);
});
