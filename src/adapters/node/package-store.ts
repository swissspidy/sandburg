/**
 * Installs the packages of an npm lockfile from a content-addressed store of unpacked packages
 * (ADR NNNN), as npm itself would unpack them: npm resolves the tree (`npm install
 * --package-lock-only`), and each package's tarball, read from npm's cache by its integrity, is
 * unpacked once into the store and hard-linked into every install that has it (as pnpm and Bun
 * do). npm unpacks Next.js's 8,700 files in ~9 s; unpacking here takes ~2 s, and linking it into a
 * later install ~0.1 s.
 *
 * What ends up in node_modules is what `npm install --ignore-scripts --omit=optional` writes: the
 * same files with the same contents and modes (pacote's rules: links and directories in the
 * tarball are skipped, .gitignore becomes .npmignore, bin targets are executable and lose a CRLF
 * after their #! line), the bin links in each node_modules/.bin (bin-links' rules: by depth, then
 * path, the first package wins a name) and npm's hidden lockfile. A lockfile this does not handle
 * (links, git dependencies, packages with their own shrinkwrap) returns false, and npm installs.
 *
 * Unpacking and linking run in worker threads (this module is also their script), off the host's
 * event loop: the host serves the tab's page while an install runs.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { availableParallelism, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { untar } from '../../node-runtime/npm/tar.ts';

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  inBundle?: boolean;
  link?: boolean;
  hasShrinkwrap?: boolean;
}

/** One package to place: its tarball (in npm's cache), its store directory and where it goes. */
interface Job {
  tarball: string;
  integrity: string;
  store: string;
  dest: string;
}

/** What a worker reports for a placed package: its package.json's name and bin. */
interface Placed {
  name?: string;
  bin?: unknown;
}

const WORKER_TAG = 'sandburg-package-store';

if (!isMainThread && (workerData as { tag?: string } | null)?.tag === WORKER_TAG) {
  parentPort!.on('message', ({ id, job }: { id: number; job: Job }) => {
    try {
      parentPort!.postMessage({ id, placed: place(job) });
    } catch (e) {
      parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Installs `dir`'s package-lock.json into dir/node_modules from the store (unpacking what it does
 * not have yet). Returns false, having changed nothing, for a lockfile it does not handle.
 */
export async function installFromLockfile(dir: string, storeRoot: string, log: (line: string) => void): Promise<boolean> {
  const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')) as Lockfile;
  if (!lock.packages || (lock.lockfileVersion ?? 1) < 2) return false;
  if (Object.entries(lock.packages).some(([location, e]) => location !== '' && (!location.startsWith('node_modules/') || e.link || e.hasShrinkwrap))) return false;
  const { installed, omitted } = partition(lock.packages);
  // Bundled packages come inside their parent's tarball.
  const fetched = installed.filter(([, e]) => !e.inBundle);
  if (fetched.some(([, e]) => !e.resolved || !e.integrity || !contentHash(e.integrity))) return false;

  const { cache } = await npmConfig();
  const tarballOf = (e: LockEntry) => contentPath(cache, e.integrity!);
  const storeOf = (e: LockEntry) => storePath(storeRoot, e.integrity!);
  // Tarballs npm's cache does not have yet (a cold ~/.npm), and that the store does not have either.
  const missing = [...new Set(fetched.filter(([, e]) => !existsSync(storeOf(e)) && !existsSync(tarballOf(e))).map(([, e]) => e.resolved!))];
  if (missing.length) {
    await npm(['cache', 'add', ...missing], dir).catch(() => {});
    if (fetched.some(([, e]) => !existsSync(storeOf(e)) && !existsSync(tarballOf(e)))) return false;
  }

  const nm = join(dir, 'node_modules');
  const jobs = fetched.map(([location, e]) => ({ location, job: { tarball: tarballOf(e), integrity: e.integrity!, store: storeOf(e), dest: join(dir, location) } }));
  // Large tarballs first, so the last worker to finish does not start Next.js last.
  const size = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  jobs.sort((a, b) => size(b.job.tarball) - size(a.job.tarball));
  try {
    const placed = new Map<string, Placed>();
    await runJobs(jobs.map((j) => j.job), (i, p) => placed.set(jobs[i].location, p));
    // Bundled packages: their package.json, as their parent's tarball had it.
    for (const [location] of installed.filter(([, e]) => e.inBundle)) {
      try {
        placed.set(location, JSON.parse(readFileSync(join(dir, location, 'package.json'), 'utf8')) as Placed);
      } catch {
        // not in the parent's tarball after all; npm would leave it out too
      }
    }
    // npm leaves the directories it made for omitted packages (a scope's, a nested node_modules).
    for (const location of omitted) if (!omitted.some((o) => location.startsWith(`${o}/`))) mkdirSync(dirname(join(dir, location)), { recursive: true });
    linkBins(dir, placed);
    // npm's record of the tree it installed (node_modules/.package-lock.json): the lockfile's
    // packages as installed.
    const hidden = { ...lock, packages: Object.fromEntries(installed) };
    await writeFile(join(nm, '.package-lock.json'), `${JSON.stringify(hidden, null, 2)}\n`);
  } catch (e) {
    rmSync(nm, { recursive: true, force: true });
    log(`package store: ${e instanceof Error ? e.message : String(e)}; npm installs instead`);
    return false;
  }
  return true;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

/** --omit=optional: what only optional dependencies need is left out (with what is nested inside it). */
function partition(packages: Record<string, LockEntry>): { installed: [string, LockEntry][]; omitted: string[] } {
  const installed: [string, LockEntry][] = [];
  const omitted: string[] = [];
  for (const [location, entry] of Object.entries(packages)) {
    if (location === '') continue;
    if (entry.optional || omitted.some((o) => location.startsWith(`${o}/`))) omitted.push(location);
    else installed.push([location, entry]);
  }
  return { installed, omitted };
}

/** sha512-… (or the strongest hash an integrity string has) as a cacache content path's parts. */
function contentHash(integrity: string): { algorithm: string; hex: string; base64: string } | null {
  for (const algorithm of ['sha512', 'sha384', 'sha256', 'sha1']) {
    const hit = integrity.split(/\s+/).find((h) => h.startsWith(`${algorithm}-`));
    if (hit) {
      const base64 = hit.slice(algorithm.length + 1).replace(/\?.*$/, '');
      const hex = Buffer.from(base64, 'base64').toString('hex');
      if (hex) return { algorithm, hex, base64 };
    }
  }
  return null;
}

/** npm's cache directory and registry (`npm config get`), asked once per process. */
function npmConfig(): Promise<{ cache: string; registry: string }> {
  config ??= new Promise((done) => {
    const child = spawn('npm', ['config', 'get', 'cache', 'registry'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const finish = () => {
      const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1].trim();
      const registry = value('registry') || 'https://registry.npmjs.org/';
      done({ cache: value('cache') || join(homedir(), '.npm'), registry: registry.endsWith('/') ? registry : `${registry}/` });
    };
    child.on('error', finish);
    child.on('close', finish);
  });
  return config;
}
let config: Promise<{ cache: string; registry: string }> | undefined;

/** Where npm's cache (cacache) keeps a tarball with this integrity. */
function contentPath(cache: string, integrity: string): string {
  const { algorithm, hex } = contentHash(integrity)!;
  return join(cache, '_cacache', 'content-v2', algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function storePath(storeRoot: string, integrity: string): string {
  const { algorithm, hex } = contentHash(integrity)!;
  return join(storeRoot, `${algorithm}-${hex}`);
}

function npm(args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('npm', [...args, '--loglevel=error'], { cwd, stdio: 'ignore', env: { ...process.env, npm_config_update_notifier: 'false' } });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`npm ${args[0]} failed (exit ${code})`))));
  });
}

/** Runs the jobs on a few worker threads; `onPlaced` gets each job's index and result. */
async function runJobs(jobs: Job[], onPlaced: (index: number, placed: Placed) => void): Promise<void> {
  if (!jobs.length) return;
  const count = Math.max(1, Math.min(4, availableParallelism(), jobs.length));
  const workers = Array.from({ length: count }, () => new Worker(new URL(import.meta.url), { workerData: { tag: WORKER_TAG } }));
  let next = 0;
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((done, fail) => {
            const give = () => {
              if (next >= jobs.length) return done();
              const id = next++;
              worker.postMessage({ id, job: jobs[id] });
            };
            worker.on('message', (m: { id: number; placed?: Placed; error?: string }) => {
              if (m.error !== undefined) return fail(new Error(m.error));
              onPlaced(m.id, m.placed!);
              give();
            });
            worker.on('error', fail);
            give();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/** In a worker: unpacks the job's tarball into the store unless it is there, and links it into place. */
function place(job: Job): Placed {
  if (!existsSync(job.store)) unpack(job);
  linkTree(job.store, job.dest);
  try {
    return JSON.parse(readFileSync(join(job.store, 'package.json'), 'utf8')) as Placed;
  } catch {
    return {};
  }
}

/** Unpacks a tarball into a new store directory, as pacote extracts it (see the module comment). */
function unpack(job: Job): void {
  const gz = readFileSync(job.tarball);
  const { algorithm, base64 } = contentHash(job.integrity)!;
  if (createHash(algorithm).update(gz).digest('base64') !== base64) throw new Error(`${job.tarball}: integrity mismatch`);
  const tmp = `${job.store}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const files = new Map<string, { data: Uint8Array; mode: number }>();
    const sawNpmignore = new Set<string>();
    for (const file of untar(gunzipSync(gz))) {
      let path = file.path;
      // npm pack treats a .gitignore as .npmignore when there is none; pacote renames it.
      if (basename(path) === '.npmignore') sawNpmignore.add(path);
      else if (basename(path) === '.gitignore') {
        const npmignore = posix.join(posix.dirname(path), '.npmignore');
        if (sawNpmignore.has(npmignore)) continue;
        path = npmignore;
      }
      files.set(path, { data: file.data, mode: file.mode });
    }
    const pkg = files.get('package.json');
    const bins = new Set(Object.values(normalizeBin(pkg ? (JSON.parse(Buffer.from(pkg.data).toString('utf8')) as Placed) : {})));
    const made = new Set<string>();
    for (const [path, { data, mode }] of files) {
      const abs = join(tmp, path);
      const parent = dirname(abs);
      if (!made.has(parent)) {
        mkdirSync(parent, { recursive: true });
        made.add(parent);
      }
      // The process's umask applies, as when npm writes the file.
      writeFileSync(abs, data, { mode: (mode | 0o666 | 0o600) & 0o7777 });
    }
    mkdirSync(tmp, { recursive: true });
    // bin-links: each binary is executable, and loses a CRLF after its #! line.
    for (const bin of bins) {
      const abs = join(tmp, bin);
      if (!files.has(bin)) continue;
      chmodSync(abs, 0o777 & ~umask);
      const text = readFileSync(abs, 'utf8');
      if (/^#![^\n]+\r\n/.test(text.slice(0, 2048))) {
        rmSync(abs);
        writeFileSync(abs, text.replace(/^(#![^\n]+)\r\n/, '$1\n'));
        chmodSync(abs, 0o777 & ~umask);
      }
    }
    try {
      renameSync(tmp, job.store);
    } catch (e) {
      // Another install unpacked it first.
      if (!existsSync(job.store)) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The process's umask (read once: process.umask() without an argument is deprecated). */
const umask = (() => {
  try {
    return process.umask();
  } catch {
    return 0o022;
  }
})();

/** Hard-links every file of a store directory into `dest` (copies where links cannot be made). */
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) linkTree(src, dst);
    else {
      try {
        linkSync(src, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
        copyFileSync(src, dst);
      }
    }
  }
}

/** npm-normalize-package-bin: a package's bin as { name: path inside the package }. */
export function normalizeBin(pkg: Placed): Record<string, string> {
  let bin = pkg.bin;
  if (typeof bin === 'string') bin = pkg.name ? { [pkg.name]: bin } : undefined;
  else if (Array.isArray(bin)) bin = Object.fromEntries(bin.map((b) => [posix.basename(String(b)), b]));
  if (!bin || typeof bin !== 'object') return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(bin as Record<string, unknown>)) {
    const name = posix.join('/', posix.basename(key.replace(/\\|:/g, '/'))).slice(1);
    if (typeof value !== 'string' || !name) continue;
    const target = posix.join('/', value.replace(/\\/g, '/')).slice(1);
    if (target) clean[name] = target;
  }
  return clean;
}

/**
 * node_modules/.bin links, as bin-links makes them: each package's binaries in the .bin of the
 * node_modules it is in, by depth and then path (en collation), the first package wins a name, and
 * a binary whose file is missing is not linked.
 */
function linkBins(dir: string, placed: Map<string, Placed>): void {
  const collator = new Intl.Collator('en');
  const depth = (l: string) => l.split('/node_modules/').length;
  const locations = [...placed.keys()].sort((a, b) => depth(a) - depth(b) || collator.compare(join(dir, a), join(dir, b)));
  const seen = new Set<string>();
  for (const location of locations) {
    const path = join(dir, location);
    const scopeOrNm = dirname(path);
    const binDir = join(basename(scopeOrNm) === 'node_modules' ? scopeOrNm : dirname(scopeOrNm), '.bin');
    for (const [name, target] of Object.entries(normalizeBin(placed.get(location)!))) {
      const to = resolve(binDir, name);
      if (seen.has(to)) continue;
      seen.add(to);
      const absFrom = resolve(path, target);
      try {
        lstatSync(absFrom);
      } catch {
        continue;
      }
      mkdirSync(binDir, { recursive: true });
      symlinkSync(relative(dirname(to), absFrom), to, 'file');
    }
  }
}
