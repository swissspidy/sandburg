/**
 * The Docker reference's container lifecycle (ADR 0004) against a fake docker CLI: the image pull,
 * labels, cleanup on dispose and at startup, and how a container reaches a loopback proxy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { hostname } from 'node:os';
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

const missingImage: Handler = () => Promise.reject(new Error('Error: No such image: node:22-slim'));

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

function runArgs(calls: string[][]): string[] {
  const run = calls.find((c) => c[0] === 'run');
  assert.ok(run, 'docker run was called');
  return run;
}

test('a cold machine pulls the image before the container starts; the container is labelled, --rm, and removed by its label', async () => {
  const workDir = tempDir('sandburg-ref-');
  const { docker, calls, commands } = fakeDocker({
    image: missingImage,
    run: async () => 'cid\n',
    ps: async (args) => (args[1] === '-aq' ? 'cid\n' : ''),
  });
  const run = dockerReference({ workDir, docker })();
  await withProxy(undefined, () => run.mount(project, () => {}));
  assert.deepEqual(commands(), ['ps -a', 'image inspect', 'pull --quiet', 'run -d']);
  const args = runArgs(calls);
  const name = args[args.indexOf('--name') + 1];
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes(`sandburg.ref=${name}`));
  assert.ok(args.includes(`sandburg.ref.pid=${process.pid}`));
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
  assert.match(err.message, /^docker pull node:22-slim failed: .*\n.*pull rate limit/);
  await first.dispose();
  await factory().mount(project, () => {}).catch(() => {});
  assert.equal(pulls, 2);
  assert.ok(!commands().includes('run -d'), 'no container without the image');
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
  const { docker, commands } = fakeDocker({
    image: missingImage,
    pull: () => new Promise((resolve) => (pulled = () => resolve(''))),
  });
  const run = dockerReference({ workDir, docker })();
  const mounting = run.mount(project, () => {}).then(() => 'mounted', () => 'rejected');
  while (!commands().includes('pull --quiet')) await new Promise((r) => setImmediate(r));
  // The session's mount deadline passed: dispose runs while the pull goes on.
  await run.dispose();
  assert.equal(await mounting, 'rejected');
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

test("startup removes the containers and project copies of this host's reference runs whose process is gone", async () => {
  const workDir = tempDir('sandburg-ref-');
  const gone = `sandburg-ref-${GONE}-x-1`;
  const mine = `sandburg-ref-${process.pid}-x-2`;
  await mkdir(join(workDir, gone));
  await mkdir(join(workDir, mine));
  const { docker, calls } = fakeDocker({
    ps: async (args) => (args[1] === '-a' ? [`aaa ${hostname()} ${GONE}`, `bbb ${hostname()} ${process.pid}`, `ccc another-host ${GONE}`].join('\n') + '\n' : ''),
  });
  await withProxy(undefined, () => dockerReference({ workDir, docker })().mount(project, () => {}));
  assert.deepEqual(calls[1], ['rm', '-f', 'aaa']);
  assert.ok(!existsSync(join(workDir, gone)));
  assert.ok(existsSync(join(workDir, mine)));
});

test('a loopback proxy is reached over a bridge network through the host gateway when it listens there, else over the host network', async () => {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // The fake bridge's gateway is the host's loopback, where the proxy listens.
  const gateway: Handler = async () => '127.0.0.1\n';
  try {
    const reachable = fakeDocker({ network: gateway });
    await withProxy(`http://127.0.0.1:${port}`, () => dockerReference({ workDir: tempDir('sandburg-ref-'), docker: reachable.docker })().mount(project, () => {}));
    const bridged = runArgs(reachable.calls);
    assert.ok(!bridged.includes('--network'));
    assert.ok(bridged.includes('--add-host=host.docker.internal:host-gateway'));
    assert.ok(bridged.includes(`HTTPS_PROXY=http://host.docker.internal:${port}`));
    assert.ok(bridged.includes('-p'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // Nothing listens on the port now: the container shares the host's network.
  const unreachable = fakeDocker({ network: gateway });
  await withProxy(`http://127.0.0.1:${port}`, () => dockerReference({ workDir: tempDir('sandburg-ref-'), docker: unreachable.docker })().mount(project, () => {}));
  const host = runArgs(unreachable.calls);
  assert.deepEqual(host.slice(host.indexOf('--network'), host.indexOf('--network') + 2), ['--network', 'host']);
  assert.ok(host.includes(`HTTPS_PROXY=http://127.0.0.1:${port}`));
  assert.ok(!host.includes('-p'));
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
  const names = calls.filter((c) => c[0] === 'run').map((c) => c[c.indexOf('--name') + 1]);
  assert.deepEqual(calls.filter((c) => c[0] === 'rm').map((c) => c[2]).sort(), names.sort());
  await assert.rejects(factory().mount(project, () => {}), /shutting down/);
  assert.deepEqual(readdirSync(workDir), []);
});
