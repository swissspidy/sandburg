/**
 * npm's resolution of an install (`npm install --package-lock-only`), run by npm's own code in a
 * worker thread that lives across installs (ADR NNNN). Most of a resolution's time goes to reading
 * and parsing full packuments (Vite's is 39 MB, and every package that peers on Vite fetches it and
 * its optional peers'), which npm keeps in memory only for one run, and only when under 1 MB. Here
 * they stay in memory between installs (up to PACKUMENT_BYTES), so the second Vite app of a batch
 * does not parse Vite again: vite-react-counter after lit-vite resolves in 0.75 s instead of 3.6 s.
 *
 * It is the npm the CLI would run (the `npm` on PATH): its `lib/npm.js` loads the configuration as
 * the CLI does in an install directory (the same user, global and environment settings and flags),
 * and its Arborist resolves and writes the lockfile, as `npm install` does. When any of that is not
 * there (another npm layout, Windows) or fails, resolve() returns false and the caller runs the CLI.
 * A resolution already running in the worker also sends the next to the CLI, so installs side by
 * side do not wait for each other.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

/** Bytes of packuments (by their length on the wire) the worker keeps. */
const PACKUMENT_BYTES = 96 << 20;
/** A worker idle this long ends, and its packuments go with it. */
const IDLE_MS = 30_000;

const WORKER_TAG = 'sandburg-npm-resolver';

interface Init {
  tag: string;
  npmRoot: string;
  /** A directory with a package.json and no .npmrc, as each install directory is: npm's local prefix. */
  configDir: string;
  flags: string[];
}

/** In the worker: loads npm once, then resolves each directory it is sent. */
async function serve({ npmRoot, configDir, flags }: Init): Promise<void> {
  const require = createRequire(join(npmRoot, 'package.json'));
  // npm's configuration also reads process.argv: only the flags count, as on the command line.
  process.argv = [process.execPath, join(npmRoot, 'bin', 'npm-cli.js')];
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  let ready: Promise<{ flat: object; Arborist: new (o: object) => { reify(o: object): Promise<unknown> } }> | null = null;
  const cache = new PackumentCache(PACKUMENT_BYTES);
  parentPort!.on('message', async ({ id, dir }: { id: number; dir: string }) => {
    try {
      ready ??= (async () => {
        const Npm = require('./lib/npm.js') as new (o: object) => { config: { cwd: string }; load(): Promise<unknown>; flatOptions: object };
        const npm = new Npm({ argv: ['install', ...flags], stdout: sink, stderr: sink });
        npm.config.cwd = configDir;
        await npm.load();
        return { flat: npm.flatOptions, Arborist: require('@npmcli/arborist') };
      })();
      const { flat, Arborist } = await ready;
      // As lib/commands/install.js runs it, with this worker's packuments.
      const opts = { ...flat, npmCommand: 'install', auditLevel: null, path: dir, add: [], workspaces: undefined, packumentCache: cache };
      await new Arborist(opts).reify(opts);
      parentPort!.postMessage({ id });
    } catch (e) {
      parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** pacote's packument cache, keeping large packuments too: least recently used out first. */
export class PackumentCache extends Map<string, { _contentLength?: number }> {
  private bytes = 0;
  private readonly max: number;
  constructor(max: number) {
    super();
    this.max = max;
  }
  override get(key: string) {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  override set(key: string, value: { _contentLength?: number }) {
    this.delete(key);
    const size = value?._contentLength ?? 0;
    // Without a length it cannot be counted, so it is not kept (as npm's own cache does).
    if (!size || size > this.max / 2) return this;
    super.set(key, value);
    this.bytes += size;
    for (const k of super.keys()) {
      if (this.bytes <= this.max) break;
      this.delete(k);
    }
    return this;
  }
  override delete(key: string) {
    const value = super.get(key);
    if (value !== undefined) this.bytes -= value._contentLength ?? 0;
    return super.delete(key);
  }
}

/** The npm package the CLI on PATH runs, if it has the layout this uses. */
function npmRoot(): string | null {
  if (process.platform === 'win32') return null;
  try {
    const bin = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    const root = dirname(dirname(realpathSync(bin)));
    return existsSync(join(root, 'lib', 'npm.js')) && existsSync(join(root, 'node_modules', '@npmcli', 'arborist')) ? root : null;
  } catch {
    return null;
  }
}

export class Resolver {
  private worker: Worker | null = null;
  private root: string | null | undefined;
  private busy = false;
  private next = 0;
  private waiting = new Map<number, (error: string | undefined) => void>();
  private idle: ReturnType<typeof setTimeout> | null = null;

  private readonly dir: string;
  private readonly flags: string[];

  /** `dir`: where its config directory goes (no .npmrc of its own, as an install directory). */
  constructor(dir: string, flags: string[]) {
    this.dir = dir;
    this.flags = flags;
  }

  /**
   * Writes dir/package-lock.json for dir/package.json (and the lockfile it starts from), as
   * `npm install --package-lock-only <flags>` would. False: not done; run the CLI.
   */
  async resolve(dir: string, log: (line: string) => void): Promise<boolean> {
    if (this.busy) return false;
    this.root ??= npmRoot();
    if (!this.root) return false;
    this.busy = true;
    if (this.idle) clearTimeout(this.idle);
    try {
      const error = await new Promise<string | undefined>((done) => {
        const id = this.next++;
        this.waiting.set(id, done);
        const worker = this.start();
        // Held while it resolves; otherwise it does not keep the process alive.
        worker.ref();
        worker.postMessage({ id, dir });
      });
      if (error === undefined) return true;
      log(`npm (in process): ${error.split('\n')[0]}; npm resolves again`);
      return false;
    } finally {
      this.worker?.unref();
      this.busy = false;
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
      this.idle.unref();
    }
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const configDir = join(this.dir, '.npm-resolver');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'package.json'), '{}\n');
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { tag: WORKER_TAG, npmRoot: this.root!, configDir, flags: this.flags } satisfies Init,
    });
    worker.unref();
    worker.on('message', ({ id, error }: { id: number; error?: string }) => {
      this.waiting.get(id)?.(error);
      this.waiting.delete(id);
    });
    const fail = (e: unknown) => {
      for (const done of this.waiting.values()) done(e instanceof Error ? e.message : String(e));
      this.waiting.clear();
      if (this.worker === worker) this.worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('the resolver ended')));
    this.worker = worker;
    return worker;
  }

  private stop(): void {
    if (this.busy) return;
    void this.worker?.terminate();
    this.worker = null;
  }
}

// Last: the worker needs the classes above.
if (!isMainThread && (workerData as Init | null)?.tag === WORKER_TAG) void serve(workerData as Init);
