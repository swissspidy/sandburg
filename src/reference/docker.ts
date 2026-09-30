/**
 * Docker reference runtime (ADR 0004): the same project, installed with real
 * npm and served by its real dev server in a container. The tab and the checks
 * are the same as for in-browser runtimes, so only the runtime differs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { contentBytes } from '../store.ts';
import { AdapterError } from '../host/types.ts';
import type { InstallReport, ProbeVerdict, Project } from '../types.ts';
import type { NodeRuntime } from '../orchestrator/session.ts';

export interface DockerReferenceOptions {
  /** Base image (default: node:22-slim). */
  image?: string;
  /** Named volume shared by all runs as npm's cache (default: sandburg-npm-cache). */
  npmCacheVolume?: string;
  /** Where project copies live while they run (default: OS temp dir). */
  workDir?: string;
}

const LOG_LIMIT = 2000;

/** Returns a factory for Session.run({ nodeRuntime }). */
export function dockerReference(options: DockerReferenceOptions = {}): () => NodeRuntime {
  const image = options.image ?? 'node:22-slim';
  return () => new DockerRun(image, options.npmCacheVolume ?? 'sandburg-npm-cache', options.workDir ?? join(tmpdir(), 'sandburg-ref'));
}

class DockerRun implements NodeRuntime {
  name = 'docker';
  version: string;
  egress: string[] = [];
  private image: string;
  private cacheVolume: string;
  private workRoot: string;
  private id = `sandburg-ref-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  private dir = '';
  private project: Project | null = null;
  private server: ChildProcess | null = null;
  private lines: string[] = [];

  constructor(image: string, cacheVolume: string, workRoot: string) {
    this.image = image;
    this.version = image;
    this.cacheVolume = cacheVolume;
    this.workRoot = workRoot;
  }

  probe(project: Project): ProbeVerdict {
    if (project.framework !== 'vite' && project.framework !== 'next' && project.framework !== 'angular') {
      return { verdict: 'unsupported', reason: `the Docker reference runs Vite, Next.js and Angular dev servers, not "${project.framework}"` };
    }
    if (!project.packageJson?.scripts?.dev) return { verdict: 'unsupported', reason: 'package.json has no "dev" script' };
    return { verdict: 'supported' };
  }

  logs(): string[] {
    return this.lines;
  }

  async mount(project: Project): Promise<void> {
    this.project = project;
    this.dir = join(this.workRoot, this.id);
    for (const [path, content] of Object.entries(project.files)) {
      const abs = join(this.dir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contentBytes(content));
    }
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    // A proxy on the host's loopback is only reachable from the host network namespace.
    const hostNetwork = !proxy || /\/\/(127\.|localhost|\[::1\])/.test(proxy);
    const args = ['run', '-d', '--name', this.id, '-v', `${this.dir}:/app`, '-v', `${this.cacheVolume}:/root/.npm`, '-w', '/app'];
    args.push('-e', 'NEXT_TELEMETRY_DISABLED=1', '-e', 'CI=1', '-e', 'npm_config_update_notifier=false');
    this.port = await freePort();
    if (hostNetwork) args.push('--network', 'host');
    else args.push('-p', `127.0.0.1:${this.port}:${this.port}`);
    if (proxy) args.push('-e', `HTTPS_PROXY=${proxy}`, '-e', `https_proxy=${proxy}`, '-e', `NO_PROXY=${process.env.NO_PROXY ?? ''}`);
    const ca = process.env.NODE_EXTRA_CA_CERTS;
    if (ca) args.push('-v', `${ca}:/sandburg-ca.crt:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/sandburg-ca.crt', '-e', 'npm_config_cafile=/sandburg-ca.crt');
    this.hostNetwork = hostNetwork;
    await this.exec('docker', [...args, this.image, 'sleep', 'infinity'], 120_000);
  }

  private hostNetwork = true;
  private port = 0;

  async install(): Promise<InstallReport> {
    const pkg = this.project!.packageJson!;
    const lock = 'package-lock.json' in this.project!.files;
    const cmd = lock ? ['npm', 'ci'] : ['npm', 'install'];
    const t0 = performance.now();
    try {
      await this.exec('docker', ['exec', this.id, ...cmd, '--no-audit', '--no-fund', '--loglevel=error'], 600_000);
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
    const framework = this.project!.framework;
    const extra = framework === 'next' ? ['-H', host, '-p', String(port)] : framework === 'angular' ? ['--host', host, '--port', String(port)] : ['--host', host, '--port', String(port), '--strictPort'];
    // Angular CLI projects have "start": "ng serve" and no "dev" script.
    const script = framework === 'angular' && !this.project!.packageJson?.scripts?.dev ? 'start' : 'dev';
    const child = spawn('docker', ['exec', this.id, 'npm', 'run', script, '--', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.server = child;
    const onData = (buf: Buffer) => this.record(buf.toString());
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
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

  async dispose(): Promise<void> {
    this.server?.kill('SIGKILL');
    await this.exec('docker', ['rm', '-f', this.id], 60_000).catch(() => {});
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  private record(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() && this.lines.length < LOG_LIMIT) this.lines.push(line.replace(/\u001b\[[0-9;]*m/g, ''));
    }
  }

  private exec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const onData = (buf: Buffer) => {
        out += buf.toString();
        this.record(buf.toString());
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited with ${code}\n${out}`));
      });
    });
  }
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
