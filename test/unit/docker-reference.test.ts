/**
 * The Docker reference's container lifecycle (ADR 0004) against a fake docker CLI: the image pull,
 * labels, cleanup on dispose and at startup, and how a container reaches a loopback proxy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dockerReference, type DockerExec } from '../../src/reference/docker.ts';
import type { Project } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';

const project = { name: 'app', path: '/app', files: { 'package.json': '{"scripts":{"dev":"vite"}}' }, packageJson: { scripts: { dev: 'vite' } }, framework: 'vite' } as unknown as Project;
/** No process has this pid (Linux's maximum is 2^22). */
const GONE = 99_999_999;

type Handler = (args: string[], options: Parameters<DockerExec>[1]) => Promise<string>;

/** A docker CLI that answers each command (`image`, `pull`, `run`, …) with its handler, and records the calls. */
function fakeDocker(handlers: Record<string, Handler>) {
  const calls: string[][] = [];
  const docker: DockerExec = (args, options) => {
    calls.push(args);
    const handler = handlers[args[0]];
    return handler ? handler(args, options) : Promise.resolve('');
  };
  return { docker, calls, commands: () => calls.map((c) => c.slice(0, 2).join(' ')) };
}

const missingImage: Handler = () => Promise.reject(new Error('Error: No such image: node:24-slim'));

/** Runs `fn` with HTTPS_PROXY set to `proxy` (or unset), restoring the environment after. */
async function withProxy<T>(proxy: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  if (proxy) process.env.HTTPS_PROXY = proxy;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The run's container (`docker run -d`), not a one-off one (the proxy probe, the npm cache's chown). */
function runArgs(calls: string[][]): string[] {
  const run = calls.find((c) => c[0] === 'run' && c[1] === '-d');
  assert.ok(run, 'docker run -d was called');
  return run;
}

const label = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
/** As another user than root, the first run gives npm's cache volume to the user (`docker run --rm … chown`). */
const asUser = process.getuid?.() ? ['run --rm'] : [];

test('a cold machine pulls the image before the container starts; the container is labelled, --rm, and removed by its label', async () => {
  const workDir = tempDir('sandburg-ref-');
  const { docker, calls, commands } = fakeDocker({
    image: missingImage,
    run: async () => 'cid\n',
    ps: async (args) => (args[1] === '-aq' ? 'cid\n' : ''),
  });
  const run = dockerReference({ workDir, docker })();
  await withProxy(undefined, () => run.mount(project, () => {}));
  assert.deepEqual(commands(), ['ps -a', 'image inspect', 'pull --quiet', ...asUser, 'run -d']);
  const args = runArgs(calls);
  const name = args[args.indexOf('--name') + 1];
  assert.ok(args.includes('--rm'));
  assert.equal(label(args, 'sandburg.ref'), name);
  assert.equal(label(args, 'sandburg.ref.pid'), String(process.pid));
  // The host, PID namespace and boot that started it (Linux has all three).
  assert.match(label(args, 'sandburg.ref.owner') ?? '', process.platform === 'linux' ? /^[^/]+\/pid:\[\d+\]\/[0-9a-f-]{36}$/ : /./);
  // No proxy: a bridge network, the port published on loopback.
  assert.ok(!args.includes('--network'));
  assert.match(args[args.indexOf('-p') + 1], /^127\.0\.0\.1:\d+:\d+$/);
  assert.ok(existsSync(join(workDir, name, 'package.json')));

  await run.dispose();
  assert.deepEqual(calls.slice(-2), [
    ['ps', '-aq', '--filter', `label=sandburg.ref=${name}`],
    ['rm', '-f', 'cid'],
  ]);
  assert.ok(!existsSync(join(workDir, name)), 'the project copy is removed');
});

test('a failed pull fails mount as infra, and the next run pulls again', async () => {
  const workDir = tempDir('sandburg-ref-');
  let pulls = 0;
  const { docker, commands } = fakeDocker({
    image: missingImage,
    pull: async () => {
      pulls++;
      throw new Error('docker pull exited with 1\ntoomanyrequests: You have reached your pull rate limit');
    },
  });
  const factory = dockerReference({ workDir, docker });
  const first = factory();
  const err = await first.mount(project, () => {}).catch((e: Error & { infra?: boolean }) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.infra, true);
  assert.match(err.message, /^docker pull node:24-slim failed: .*\n.*pull rate limit/);
  await first.dispose();
  await factory().mount(project, () => {}).catch(() => {});
  assert.equal(pulls, 2);
  assert.ok(!commands().includes('run -d'), 'no container without the image');
});

test('an image that does not exist fails every run as infra, with one pull', async () => {
  let pulls = 0;
  const { docker } = fakeDocker({
    image: missingImage,
    pull: async () => {
      pulls++;
      throw new Error('docker pull exited with 1\nError response from daemon: manifest unknown');
    },
  });
  const factory = dockerReference({ workDir: tempDir('sandburg-ref-'), docker });
  for (let i = 0; i < 3; i++) await assert.rejects(factory().mount(project, () => {}), (e: Error & { infra?: boolean }) => e.infra === true && /manifest unknown/.test(e.message));
  assert.equal(pulls, 1);
});

test('a "not found" from a registry mirror or proxy is not taken for an image that does not exist: the next run pulls again', async () => {
  let pulls = 0;
  const { docker } = fakeDocker({
    image: missingImage,
    pull: async () => {
      pulls++;
      throw new Error('docker pull exited with 1\nError response from daemon: Get "https://mirror.example/v2/": 404 not found');
    },
  });
  const factory = dockerReference({ workDir: tempDir('sandburg-ref-'), docker });
  for (let i = 0; i < 2; i++) await assert.rejects(factory().mount(project, () => {}), (e: Error & { infra?: boolean }) => e.infra === true);
  assert.equal(pulls, 2);
});

test('"manifest for … not found" is an image that does not exist', async () => {
  let pulls = 0;
  const { docker } = fakeDocker({
    image: missingImage,
    pull: async () => {
      pulls++;
      throw new Error('docker pull exited with 1\nError response from daemon: manifest for node:99-slim not found');
    },
  });
  const factory = dockerReference({ workDir: tempDir('sandburg-ref-'), docker });
  for (let i = 0; i < 2; i++) await assert.rejects(factory().mount(project, () => {}));
  assert.equal(pulls, 1);
});

test('no Docker daemon fails mount as infra, without a pull', async () => {
  const { docker, commands } = fakeDocker({
    image: () => Promise.reject(new Error('docker image inspect exited with 1\nfailed to connect to the docker API at unix:///var/run/docker.sock')),
  });
  const err = await dockerReference({ workDir: tempDir('sandburg-ref-'), docker })().mount(project, () => {}).catch((e: Error & { infra?: boolean }) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.infra, true);
  assert.deepEqual(commands(), ['ps -a', 'image inspect']);
});

test('a run disposed while the image is still pulling never creates its container', async () => {
  const workDir = tempDir('sandburg-ref-');
  let pulled!: () => void;
  let pullSignal: AbortSignal | undefined;
  const { docker, commands } = fakeDocker({
    image: missingImage,
    pull: (_args, options) => {
      pullSignal = options.signal;
      return new Promise((resolve) => (pulled = () => resolve('')));
    },
  });
  const run = dockerReference({ workDir, docker })();
  const mounting = run.mount(project, () => {}).then(() => 'mounted', () => 'rejected');
  while (!commands().includes('pull --quiet')) await new Promise((r) => setImmediate(r));
  // The session's mount deadline passed: dispose runs while the pull goes on.
  await run.dispose();
  assert.equal(await mounting, 'rejected');
  assert.equal(pullSignal?.aborted, true, 'the pull no run waits for any more is stopped');
  pulled();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!commands().includes('run -d'), commands().join(', '));
});

test('dispose stops a docker run still in flight and removes the container it created', async () => {
  const workDir = tempDir('sandburg-ref-');
  let created = false;
  let aborted = false;
  const { docker, calls } = fakeDocker({
    run: (_args, options) =>
      new Promise((_resolve, reject) => {
        created = true;
        options.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('docker run killed'));
        });
      }),
    ps: async (args) => (args[1] === '-aq' && created ? 'late\n' : ''),
  });
  const run = dockerReference({ workDir, docker })();
  const mounting = run.mount(project, () => {}).catch(() => {});
  while (!created) await new Promise((r) => setImmediate(r));
  await run.dispose();
  await mounting;
  assert.ok(aborted, 'docker run was killed');
  assert.deepEqual(calls.at(-1), ['rm', '-f', 'late']);
});

test("startup removes the containers and project copies of this host's, PID namespace's and boot's reference runs whose process is gone", async () => {
  const workDir = tempDir('sandburg-ref-');
  // A first run tells this process's owner label and name.
  const first = fakeDocker({});
  await withProxy(undefined, () => dockerReference({ workDir, docker: first.docker })().mount(project, () => {}));
  const args = runArgs(first.calls);
  const owner = label(args, 'sandburg.ref.owner');
  const tag = /^sandburg-ref-([0-9a-f]{8})-/.exec(args[args.indexOf('--name') + 1])![1];
  const gone = `sandburg-ref-${tag}-${GONE}-x-1`;
  const mine = `sandburg-ref-${tag}-${process.pid}-x-2`;
  const elsewhere = `sandburg-ref-00000000-${GONE}-x-3`;
  for (const dir of [gone, mine, elsewhere]) await mkdir(join(workDir, dir));
  const { docker, calls } = fakeDocker({
    // Only this owner's containers are listed (the filter); of them, the one whose process is gone goes.
    ps: async (a) => (a[1] === '-a' && a[3] === `label=sandburg.ref.owner=${owner}` ? [`aaa ${GONE}`, `bbb ${process.pid}`].join('\n') + '\n' : ''),
  });
  await withProxy(undefined, () => dockerReference({ workDir, docker })().mount(project, () => {}));
  assert.deepEqual(calls[1], ['rm', '-f', 'aaa']);
  assert.ok(!existsSync(join(workDir, gone)));
  assert.ok(existsSync(join(workDir, mine)));
  assert.ok(existsSync(join(workDir, elsewhere)), 'another owner\'s copy stays');
});

test('leftovers whose pid cannot be checked are kept: only a pid with no such process (ESRCH) is gone', async (t) => {
  const workDir = tempDir('sandburg-ref-');
  const first = fakeDocker({});
  await withProxy(undefined, () => dockerReference({ workDir, docker: first.docker })().mount(project, () => {}));
  const args = runArgs(first.calls);
  const owner = label(args, 'sandburg.ref.owner');
  const tag = /^sandburg-ref-([0-9a-f]{8})-/.exec(args[args.indexOf('--name') + 1])![1];
  /** Too large for process.kill (ERR_INVALID_ARG_TYPE). */
  const HUGE = '99999999999999';
  /** process.kill fails for it with an error other than ESRCH. */
  const ODD = 4_000_001;
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid === ODD) throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' });
    return kill(pid, signal);
  });
  const dirs = { gone: `sandburg-ref-${tag}-${GONE}-x-1`, huge: `sandburg-ref-${tag}-${HUGE}-x-2`, odd: `sandburg-ref-${tag}-${ODD}-x-3` };
  for (const dir of Object.values(dirs)) await mkdir(join(workDir, dir));
  const { docker, calls } = fakeDocker({
    // A container per case: no pid label, not a number, zero, negative, too large, an unexpected error, gone.
    ps: async (a) => (a[1] === '-a' && a[3] === `label=sandburg.ref.owner=${owner}` ? ['none ', 'nan x', 'zero 0', 'neg -5', `huge ${HUGE}`, `odd ${ODD}`, `gone ${GONE}`].join('\n') + '\n' : ''),
  });
  await withProxy(undefined, () => dockerReference({ workDir, docker })().mount(project, () => {}));
  assert.deepEqual(calls.filter((c) => c[0] === 'rm'), [['rm', '-f', 'gone']]);
  assert.ok(!existsSync(join(workDir, dirs.gone)), 'the copy of a gone process is removed');
  assert.ok(existsSync(join(workDir, dirs.huge)), 'a pid too large to check keeps its copy');
  assert.ok(existsSync(join(workDir, dirs.odd)), 'a pid kill() fails for otherwise keeps its copy');
});

test('the directory of project copies must be a directory of this user\'s, not a symlink', async () => {
  const target = tempDir('sandburg-ref-target-');
  const leftover = `sandburg-ref-00000000-${GONE}-x-1`;
  await mkdir(join(target, leftover));
  const link = join(tempDir('sandburg-ref-link-'), 'copies');
  await symlink(target, link);
  const { docker, commands } = fakeDocker({});
  await assert.rejects(dockerReference({ workDir: link, docker })().mount(project, () => {}), (e: Error & { infra?: boolean }) => e.infra === true && /is not a directory of this user's/.test(e.message));
  assert.deepEqual(commands(), []);
  assert.ok(existsSync(join(target, leftover)));
});

test('as a user other than root, containers run as that user, with npm\'s home and its own cache volume under /tmp', { skip: process.platform === 'win32' && 'Windows has no POSIX user ids (process.getuid), so containers run as the image\'s user' }, async (t) => {
  const workDir = tempDir('sandburg-ref-');
  // As root, the test plays uid 1000 (the directory of copies must be its).
  const uid = process.getuid!() || 1000;
  const gid = process.getuid!() ? process.getgid!() : 1000;
  if (!process.getuid!()) chownSync(workDir, uid, gid);
  t.mock.method(process as { getuid(): number }, 'getuid', () => uid);
  t.mock.method(process as { getgid(): number }, 'getgid', () => gid);
  const { docker, calls } = fakeDocker({});
  await withProxy(undefined, () => dockerReference({ workDir, docker })().mount(project, () => {}));
  const chown = calls.find((c) => c[0] === 'run' && c.includes('chown'));
  assert.ok(chown, 'the cache volume is given to the user');
  assert.deepEqual(chown.slice(-5), [`sandburg-npm-cache-${uid}:/cache`, 'node:24-slim', 'chown', `${uid}:${gid}`, '/cache']);
  const args = runArgs(calls);
  assert.deepEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', `${uid}:${gid}`]);
  assert.ok(args.includes('HOME=/tmp'));
  assert.ok(args.includes(`sandburg-npm-cache-${uid}:/tmp/.npm`));
});

test('a loopback proxy is reached over a bridge network through the host gateway when a container can connect to it there, else over the host network', async () => {
  const proxy = 'http://127.0.0.1:3128';
  /** A docker CLI whose probe container connects to the proxy, or not (a firewall on the bridge drops it). */
  const probing = (connects: boolean) =>
    fakeDocker({
      run: async (args) => {
        if (!args.includes('node')) return '';
        if (connects) return '';
        throw new Error('docker run exited with 1');
      },
    });
  const reachable = probing(true);
  await withProxy(proxy, () => dockerReference({ workDir: tempDir('sandburg-ref-'), docker: reachable.docker })().mount(project, () => {}));
  const probe = reachable.calls.find((c) => c.includes('node'))!;
  assert.ok(probe.includes('--add-host=host.docker.internal:host-gateway'));
  assert.ok(probe.includes('--rm'));
  assert.match(probe.at(-1)!, /connect\(3128, 'host\.docker\.internal'\).*setTimeout\(3000\)/);
  const bridged = runArgs(reachable.calls);
  assert.ok(!bridged.includes('--network'));
  assert.ok(bridged.includes('--add-host=host.docker.internal:host-gateway'));
  assert.ok(bridged.includes('HTTPS_PROXY=http://host.docker.internal:3128'));
  assert.ok(bridged.includes('-p'));

  const unreachable = probing(false);
  const factory = dockerReference({ workDir: tempDir('sandburg-ref-'), docker: unreachable.docker });
  await withProxy(proxy, async () => {
    await factory().mount(project, () => {});
    await factory().mount(project, () => {});
  });
  const host = runArgs(unreachable.calls);
  assert.deepEqual(host.slice(host.indexOf('--network'), host.indexOf('--network') + 2), ['--network', 'host']);
  assert.ok(host.includes(`HTTPS_PROXY=${proxy}`));
  assert.ok(!host.includes('-p'));
  assert.equal(unreachable.calls.filter((c) => c.includes('node')).length, 1, 'the probe runs once per factory');
});

test('disposeAll removes every mounted run and refuses new ones (Ctrl-C during compare)', async () => {
  const workDir = tempDir('sandburg-ref-');
  const { docker, calls } = fakeDocker({
    // Each container's id is its run's label.
    ps: async (args) => (args[1] === '-aq' ? `${args[3].slice('label=sandburg.ref='.length)}\n` : ''),
  });
  const factory = dockerReference({ workDir, docker });
  await withProxy(undefined, async () => {
    await factory().mount(project, () => {});
    await factory().mount(project, () => {});
  });
  await factory.disposeAll();
  const names = calls.filter((c) => c[0] === 'run' && c[1] === '-d').map((c) => c[c.indexOf('--name') + 1]);
  assert.deepEqual(calls.filter((c) => c[0] === 'rm').map((c) => c[2]).sort(), names.sort());
  await assert.rejects(factory().mount(project, () => {}), /shutting down/);
  assert.deepEqual(readdirSync(workDir), []);
});
