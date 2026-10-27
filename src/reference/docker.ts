/**
 * Docker reference runtime (ADR 0004): the same project, installed with real
 * npm and served by its real dev server in a container. The tab and the checks
 * are the same as for in-browser runtimes, so only the runtime differs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, readlinkSync } from 'node:fs';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { contentBytes } from '../store.ts';
import { DEV_ENV } from '../adapters/node/scripts.ts';
import { AdapterError } from '../host/types.ts';
import type { InstallReport, ProbeVerdict, Project } from '../types.ts';
import { FRAMEWORKS, frameworkInfo } from '../framework.ts';
import type { NodeRuntime } from '../orchestrator/session.ts';

/** Options of dockerReference(): the image and where the container's files and npm cache live. */
export interface DockerReferenceOptions {
  /** Base image (default: node:24-slim). */
  image?: string;
  /** Named volume shared by all runs as npm's cache (default: sandburg-npm-cache, and sandburg-npm-cache-<uid> for a user other than root). */
  npmCacheVolume?: string;
  /** Where project copies live while they run, a directory this user owns (default: sandburg-ref-<uid> in the OS temp dir). */
  workDir?: string;
  /** Runs the docker CLI with these arguments and returns its output (default: spawns `docker`; tests pass a fake). */
  docker?: DockerExec;
}

/** Runs `docker <args>`: resolves with its output, rejects when it exits with an error, times out or is aborted. */
export type DockerExec = (args: string[], options: { timeoutMs: number; signal?: AbortSignal; onData?: (text: string) => void }) => Promise<string>;

/** dockerReference()'s factory, and a way to remove every container and project copy it has running. */
export type DockerReferenceFactory = (() => NodeRuntime) & { disposeAll(): Promise<void> };

const LOG_LIMIT = 2000;
/** How long the image pull may take on a cold machine (node images are 70–250 MB). */
const PULL_TIMEOUT_MS = 600_000;
/** Docker's answers for an image that cannot exist; a bare "not found" (a proxy's or mirror's, often passing) is not one. */
const PERMANENT_PULL_FAILURE = /manifest unknown|manifest for \S+ not found|repository does not exist|pull access denied|invalid reference format/i;
/** Every container carries its run's id in this label, who started it (OWNER) in the next, and the pid in the last. */
const LABEL = 'sandburg.ref';
const OWNER_LABEL = 'sandburg.ref.owner';
const PID_LABEL = 'sandburg.ref.pid';

/**
 * Who starts this process's containers and project copies: the host, its PID namespace and its boot. A
 * pid tells a gone process only with all three (two jobs may share a hostname and a Docker socket, each
 * in a PID namespace of its own). Empty parts where the system has no /proc.
 */
const OWNER = [hostname(), orEmpty(() => readlinkSync('/proc/self/ns/pid')), orEmpty(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())].join('/');
/** OWNER in a container's and project copy's name (sandburg-ref-<owner>-<pid>-…). */
const OWNER_TAG = createHash('sha256').update(OWNER).digest('hex').slice(0, 8);

function orEmpty(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}

/** The host user the containers run as, unless it is root: the files they write in the project copy are its own, so it can remove them. */
interface HostUser {
  uid: number;
  gid: number;
}

/**
 * Returns a factory for Session.run({ nodeRuntime }). The first run removes what earlier processes on
 * this machine left behind (containers and project copies of a process that is gone), pulls the image
 * if it is missing, and decides how containers reach the host's proxy; the others wait for it.
 */
export function dockerReference(options: DockerReferenceOptions = {}): DockerReferenceFactory {
  const image = options.image ?? 'node:24-slim';
  const docker = options.docker ?? runDocker;
  const uid = process.getuid?.();
  const user: HostUser | null = uid === undefined || uid === 0 ? null : { uid, gid: process.getgid!() };
  const workRoot = options.workDir ?? join(tmpdir(), `sandburg-ref-${uid ?? 'user'}`);
  const cacheVolume = options.npmCacheVolume ?? (user ? `sandburg-npm-cache-${user.uid}` : 'sandburg-npm-cache');
  const pool: Pool = { live: new Set(), closed: false };
  let setup: { promise: Promise<Setup>; abort: AbortController; waiting: number; settled: boolean } | null = null;
  /** A pull that cannot succeed (no such image): every run fails with it without asking the registry again. */
  let permanent: Error | null = null;
  const prepare = async (signal: AbortSignal): Promise<Setup> => {
    if (permanent) throw permanent;
    if (!setup) {
      const abort = new AbortController();
      const current = { promise: prepareDocker({ docker, image, workRoot, cacheVolume, user }, abort.signal), abort, waiting: 0, settled: false };
      current.promise.then(
        () => (current.settled = true),
        (err: Error & { permanent?: boolean }) => {
          current.settled = true;
          // A later run (the session's infra retry) tries again, unless the image does not exist.
          if (setup === current) setup = null;
          if (err.permanent) permanent = err;
        },
      );
      setup = current;
    }
    const current = setup;
    current.waiting++;
    try {
      return await abortable(current.promise, signal);
    } finally {
      // The last run waiting for it was disposed: the pull (or probe) is stopped, and the next run starts over.
      if (--current.waiting === 0 && !current.settled) {
        current.abort.abort();
        if (setup === current) setup = null;
      }
    }
  };
  const factory = () => new DockerRun({ image, cacheVolume, workRoot, docker, prepare, pool, user });
  const disposeAll = async () => {
    pool.closed = true;
    await Promise.all([...pool.live].map((run) => run.dispose()));
  };
  return Object.assign(factory, { disposeAll });
}

/** A factory's runs that have mounted and are not disposed yet; once closed (disposeAll), no new run mounts. */
interface Pool {
  live: Set<DockerRun>;
  closed: boolean;
}

/** How containers reach the network: the host's (for a proxy on its loopback that only it can reach), or a bridge. */
interface Setup {
  hostNetwork: boolean;
  /** The proxy as the container sees it. */
  proxy: string | undefined;
}

/** An error of the reference's own (no Docker daemon, an image it could not pull): the run is classed infra, not the app's. */
function infraError(message: string, extra: { permanent?: boolean } = {}): Error {
  return Object.assign(new Error(message), { infra: true }, extra);
}

/** The labels of a container this process starts: removeLeftovers finds it by them once the process is gone. */
function ownerLabels(id: string): string[] {
  return ['--label', `${LABEL}=${id}`, '--label', `${OWNER_LABEL}=${OWNER}`, '--label', `${PID_LABEL}=${process.pid}`];
}

async function prepareDocker(o: { docker: DockerExec; image: string; workRoot: string; cacheVolume: string; user: HostUser | null }, signal: AbortSignal): Promise<Setup> {
  const { docker, image } = o;
  await ownedRoot(o.workRoot);
  await removeLeftovers(docker, o.workRoot);
  try {
    await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 30_000, signal });
  } catch (err) {
    const message = (err as Error).message;
    if (/Cannot connect to the Docker daemon|connect to the docker API/i.test(message)) throw infraError(tail(message));
    signal.throwIfAborted();
    try {
      await docker(['pull', '--quiet', image], { timeoutMs: PULL_TIMEOUT_MS, signal });
    } catch (pullErr) {
      const text = (pullErr as Error).message;
      throw infraError(`docker pull ${image} failed: ${tail(text)}`, { permanent: PERMANENT_PULL_FAILURE.test(text) });
    }
  }
  // npm's cache volume is root's when Docker makes it: the host user's containers need it as theirs.
  if (o.user) {
    await docker(['run', '--rm', ...ownerLabels('sandburg-ref-setup'), '-v', `${o.cacheVolume}:/cache`, image, 'chown', `${o.user.uid}:${o.user.gid}`, '/cache'], { timeoutMs: 60_000, signal }).catch((err: Error) => {
      throw infraError(`could not give npm's cache volume ${o.cacheVolume} to uid ${o.user!.uid}: ${tail(err.message)}`);
    });
  }
  return networkSetup(docker, image, signal);
}

/**
 * The proxy the container uses, and how it reaches it. A proxy on the host's loopback is reached from
 * a bridge network through the host's gateway when a container can connect to it there (it listens on
 * the bridge too, and no firewall drops the traffic); else (it listens on 127.0.0.1 only, as most
 * local proxies do) the container shares the host's network, with no isolation from the host's
 * services (ADR 0004).
 */
async function networkSetup(docker: DockerExec, image: string, signal: AbortSignal): Promise<Setup> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxy) return { hostNetwork: false, proxy };
  const url = URL.canParse(proxy) ? new URL(proxy) : null;
  if (!url || !/^(127\.|localhost$|\[::1\]$)/.test(url.hostname)) return { hostNetwork: false, proxy };
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const probe = `const s = require('net').connect(${port}, 'host.docker.internal'); s.setTimeout(3000); s.on('connect', () => process.exit(0)); s.on('timeout', () => process.exit(1)); s.on('error', () => process.exit(1));`;
  const reachable = await docker(['run', '--rm', ...ownerLabels('sandburg-ref-probe'), '--add-host=host.docker.internal:host-gateway', image, 'node', '-e', probe], { timeoutMs: 60_000, signal }).then(
    () => true,
    () => false,
  );
  signal.throwIfAborted();
  if (!reachable) return { hostNetwork: true, proxy };
  url.hostname = 'host.docker.internal';
  return { hostNetwork: false, proxy: url.href.replace(/\/$/, '') };
}

/** Makes the directory of project copies, and checks that it is a directory of this user's, not a symlink, before anything goes in or out of it. */
async function ownedRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const st = await lstat(workRoot);
  const uid = process.getuid?.();
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw infraError(`${workRoot} is not a directory of this user's: the Docker reference keeps its project copies there`);
  }
}

/**
 * Containers and project copies of reference runs whose process is gone (Ctrl-C twice, a crash, a
 * kill): only those of this host, PID namespace and boot (OWNER), so a pid that is not alive here is
 * one that is gone.
 */
async function removeLeftovers(docker: DockerExec, workRoot: string): Promise<void> {
  const listed = await docker(['ps', '-a', '--filter', `label=${OWNER_LABEL}=${OWNER}`, '--format', `{{.ID}} {{.Label "${PID_LABEL}"}}`], { timeoutMs: 30_000 }).catch(() => '');
  const stale = listed.split('\n').flatMap((line) => {
    const [id, pid] = line.trim().split(' ');
    return id && !alive(Number(pid)) ? [id] : [];
  });
  if (stale.length) await docker(['rm', '-f', ...stale], { timeoutMs: 60_000 }).catch(() => {});
  const dirs = await readdir(workRoot).catch(() => []);
  for (const name of dirs) {
    const m = /^sandburg-ref-([0-9a-f]{8})-(\d+)-/.exec(name);
    if (m && m[1] === OWNER_TAG && !alive(Number(m[2]))) await rm(join(workRoot, name), { recursive: true, force: true }).catch(() => {});
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class DockerRun implements NodeRuntime {
  name = 'docker';
  version: string;
  egress: string[] = [];
  /** Mount may wait for the image pull (see prepareDocker); dispose waits for a container being removed. */
  timeouts = { mount: PULL_TIMEOUT_MS + 60_000, dispose: 60_000 };
  private image: string;
  private cacheVolume: string;
  private workRoot: string;
  private docker: DockerExec;
  private prepare: (signal: AbortSignal) => Promise<Setup>;
  private pool: Pool;
  private user: HostUser | null;
  /** The container's name and the project copy's directory; its owner and pid let a later process tell leftovers (removeLeftovers). */
  private id = `sandburg-ref-${OWNER_TAG}-${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  private dir = '';
  private project: Project | null = null;
  private server: ChildProcess | null = null;
  private lines: string[] = [];
  /** Aborts what mount is still doing (waiting for the pull, `docker run`) when the run is disposed. */
  private abort = new AbortController();
  private mounting: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;

  constructor(o: { image: string; cacheVolume: string; workRoot: string; docker: DockerExec; prepare: (signal: AbortSignal) => Promise<Setup>; pool: Pool; user: HostUser | null }) {
    this.image = o.image;
    this.version = o.image;
    this.cacheVolume = o.cacheVolume;
    this.workRoot = o.workRoot;
    this.docker = o.docker;
    this.prepare = o.prepare;
    this.pool = o.pool;
    this.user = o.user;
  }

  probe(project: Project): ProbeVerdict {
    if (!frameworkInfo(project.framework)?.reference) {
      const titles = Object.values(FRAMEWORKS).flatMap((f) => (f.reference ? [f.title] : []));
      return { verdict: 'unsupported', reason: `the Docker reference runs ${titles.slice(0, -1).join(', ')} and ${titles.at(-1)} dev servers, not "${project.framework}"` };
    }
    if (!project.packageJson?.scripts?.dev) return { verdict: 'unsupported', reason: 'package.json has no "dev" script' };
    return { verdict: 'supported' };
  }

  logs(): string[] {
    return this.lines;
  }

  mount(project: Project): Promise<void> {
    if (this.pool.closed) return Promise.reject(new Error('the Docker reference is shutting down'));
    this.pool.live.add(this);
    this.mounting = this.mountContainer(project);
    return this.mounting;
  }

  private async mountContainer(project: Project): Promise<void> {
    const signal = this.abort.signal;
    const setup = await this.prepare(signal);
    this.project = project;
    this.dir = join(this.workRoot, this.id);
    for (const [path, content] of Object.entries(project.files)) {
      signal.throwIfAborted();
      const abs = join(this.dir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contentBytes(content));
    }
    const { hostNetwork, proxy } = setup;
    // --rm: a container that stops is removed by Docker; the labels find the others (dispose, removeLeftovers).
    const args = ['run', '-d', '--rm', '--name', this.id, ...ownerLabels(this.id)];
    // As the host user (not root), npm's home and cache are under /tmp.
    const home = this.user ? '/tmp' : '/root';
    if (this.user) args.push('--user', `${this.user.uid}:${this.user.gid}`, '-e', `HOME=${home}`);
    args.push('-v', `${this.dir}:/app`, '-v', `${this.cacheVolume}:${home}/.npm`, '-w', '/app');
    for (const [k, v] of Object.entries(DEV_ENV)) args.push('-e', `${k}=${v}`);
    args.push('-e', 'npm_config_update_notifier=false');
    this.port = await freePort();
    if (hostNetwork) args.push('--network', 'host');
    else args.push('-p', `127.0.0.1:${this.port}:${this.port}`);
    if (proxy?.includes('//host.docker.internal')) args.push('--add-host=host.docker.internal:host-gateway');
    if (proxy) args.push('-e', `HTTPS_PROXY=${proxy}`, '-e', `https_proxy=${proxy}`, '-e', `NO_PROXY=${process.env.NO_PROXY ?? ''}`);
    const ca = process.env.NODE_EXTRA_CA_CERTS;
    if (ca) args.push('-v', `${ca}:/sandburg-ca.crt:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/sandburg-ca.crt', '-e', 'npm_config_cafile=/sandburg-ca.crt');
    this.hostNetwork = hostNetwork;
    if (hostNetwork && proxy) this.lines.push('[sandburg] the container shares the host network: a container on a bridge cannot reach the proxy on the host\'s loopback');
    await this.exec([...args, this.image, 'sleep', 'infinity'], 120_000, signal);
  }

  private hostNetwork = true;
  private port = 0;

  async install(): Promise<InstallReport> {
    const pkg = this.project!.packageJson!;
    const lock = 'package-lock.json' in this.project!.files;
    const cmd = lock ? ['npm', 'ci'] : ['npm', 'install'];
    const t0 = performance.now();
    try {
      await this.exec(['exec', this.id, ...cmd, '--no-audit', '--no-fund', '--loglevel=error'], 600_000);
    } catch (err) {
      const text = (err as Error).message;
      // The registry says the dependency does not exist or cannot be resolved: the project's fault.
      const appFault = /E404|ETARGET|ERESOLVE|No matching version|is not in this registry|EJSONPARSE/.test(text);
      throw new AdapterError(appFault ? 'APP' : 'INTERNAL', `${cmd.join(' ')} failed: ${tail(text)}`);
    }
    this.lines.push(`[sandburg] ${cmd.join(' ')} took ${Math.round(performance.now() - t0)} ms`);
    return { resolution: lock ? 'lockfile' : Object.keys(pkg.dependencies ?? {}).length ? 'range' : 'none', lockfileHonored: lock, dependencies: { ...pkg.dependencies } };
  }

  async start(): Promise<{ port: number }> {
    const port = this.port;
    // Host network: bind loopback only. Bridge network: bind all interfaces; Docker publishes the port on 127.0.0.1.
    const host = this.hostNetwork ? '127.0.0.1' : '0.0.0.0';
    const reference = frameworkInfo(this.project!.framework)!.reference!;
    const extra = reference.listen(host, port);
    const script = reference.script(this.project!.packageJson);
    const child = spawn('docker', ['exec', this.id, 'npm', 'run', script, '--', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.server = child;
    const onData = (buf: Buffer) => this.record(buf.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let exited: string | null = null;
    child.on('exit', (code) => (exited = `dev server exited with code ${code}`));
    // Ready when the dev server answers "/" (dev servers compile on the first request).
    for (;;) {
      if (exited) throw new AdapterError('APP', `${exited}: ${tail(this.lines.join('\n'))}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(60_000) });
        await res.arrayBuffer();
        return { port };
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /**
   * Stops what mount is still doing and waits for it, so that a container it was creating (a mount
   * past its deadline) is removed too; then removes the container by its label, and the project copy.
   */
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.abort.abort();
      this.server?.kill('SIGKILL');
      await this.mounting?.catch(() => {});
      const ids = await this.docker(['ps', '-aq', '--filter', `label=${LABEL}=${this.id}`], { timeoutMs: 30_000 }).catch(() => '');
      const list = ids.split('\n').map((l) => l.trim()).filter(Boolean);
      if (list.length) await this.docker(['rm', '-f', ...list], { timeoutMs: 60_000 }).catch(() => {});
      if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.pool.live.delete(this);
    })();
    return this.disposing;
  }

  private record(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() && this.lines.length < LOG_LIMIT) this.lines.push(line.replace(/\u001b\[[0-9;]*m/g, ''));
    }
  }

  private exec(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return this.docker(args, { timeoutMs, signal, onData: (text) => this.record(text) });
  }
}

/** The docker CLI (DockerExec). A timeout or an abort kills it; either way it settles only once it has exited. */
function runDocker(args: string[], options: { timeoutMs: number; signal?: AbortSignal; onData?: (text: string) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason);
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (buf: Buffer) => {
      out += buf.toString();
      options.onData?.(buf.toString());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      if (code === 0) resolve(out);
      else reject(new Error(`docker ${args.slice(0, 3).join(' ')} exited with ${code}\n${out}`));
    });
  });
}

/** `promise`, or a rejection as soon as `signal` aborts (what it waits for goes on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function tail(text: string, lines = 15): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
