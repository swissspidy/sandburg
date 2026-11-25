/**
 * Git dependencies (ADR 0073): the host fetches a git dependency's files itself and hands them to
 * the install plan as a local package, so that npm never sees it. npm would clone it and *prepare*
 * it (install its dependencies and run its `prepare` script) on the host, whatever
 * `--ignore-scripts` says (spec-guard.ts, ADR 0054); here nothing of it runs: its files are read,
 * not executed, and it is linked into node_modules as a workspace is (local-packages.ts), its
 * registry dependencies installed with the project's.
 *
 * Fast: a branch or tag is resolved to its commit with one ls-refs request (isomorphic-git, git's
 * protocol v2, filtered by the server), none for a full commit id or one the project's
 * package-lock.json records; the files of a commit on GitHub, GitLab or Bitbucket are one archive
 * download, kept on disk by commit, so a second run fetches nothing but the ref (and not that within
 * a few minutes). Another host's repository (SANDBURG_GIT_HOSTS) is fetched by isomorphic-git, a
 * shallow fetch of the one commit.
 *
 * The host fetches from the repository's host only: no redirect leaves it (a project names the URL,
 * and the host must not become its way into an internal address).
 */
import { mkdir, readFile, rename, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import git from 'isomorphic-git';
import semver from 'semver';
import { untar } from './browser-npm/tar.ts';
import { FULL_SHA, extraGitHosts, parseGitSpec, type GitSpec } from './git-spec.ts';
import { GIT_DIR, GIT_FILE, installPlan, type InstallPlan } from './local-packages.ts';
import { UnsupportedDependencyError, unsupportedDependency } from './spec-guard.ts';
import { isText } from '../../store.ts';
import type { FileTree, Project } from '../../types.ts';

/** What the host fetches for git dependencies, at most (the tests lower them). */
export const gitLimits = {
  /** Git specs per project (each git package may name more). */
  packages: 50,
  /** One repository: files, and bytes unpacked; a response (an archive, a pack) is no larger either. */
  files: 20_000,
  bytes: 256 * 1024 * 1024,
  /** A project's git packages together: files and bytes unpacked, and bytes received, across the fetches it runs at once. */
  totalFiles: 50_000,
  totalBytes: 512 * 1024 * 1024,
  /** Repositories' files kept in memory across runs (the disk keeps them all). */
  memoryBytes: 256 * 1024 * 1024,
};
/** How long a branch or tag's commit is taken as known without asking again. */
const REF_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 60_000;

/** A failure that is the project's: a repository, branch or tag that is not there (npm: an app bug). */
function appError(message: string): Error {
  return Object.assign(new Error(message), { code: 'APP' });
}

/** Where fetched repositories are kept, by commit (SANDBURG_GIT_DIR, else .sandburg/git). */
const cacheRoot = () => resolve(process.env.SANDBURG_GIT_DIR ?? '.sandburg/git');

/**
 * fetch() that follows a redirect only within `origins` (and over HTTPS), and gives up after
 * TIMEOUT_MS. What a project names is fetched from its own host, never from another it redirects to.
 */
async function hostFetch(url: string, origins: Set<string>, init: RequestInit = {}): Promise<Response> {
  let at = url;
  for (let hops = 0; hops < 5; hops++) {
    const u = URL.parse(at);
    if (!u || u.protocol !== 'https:' || !origins.has(u.origin)) throw new Error(`git: refused to fetch ${at} (not the repository's host)`);
    const res = await fetch(at, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (!location) return res;
    at = new URL(location, at).href;
  }
  throw new Error(`git: too many redirects from ${url}`);
}

/** isomorphic-git's HTTP client, over hostFetch (so its requests stay on the repository's host). */
function httpClient(origins: Set<string>, budget?: Budget): Parameters<typeof git.listServerRefs>[0]['http'] {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      let data: Uint8Array | undefined;
      if (body) {
        const parts: Uint8Array[] = [];
        for await (const chunk of body) parts.push(chunk);
        data = Buffer.concat(parts);
      }
      const res = await hostFetch(url, origins, { method, headers, body: data as BodyInit | undefined });
      // Bounded as an archive is: no response larger than a repository may be, nor than the project has left.
      const bytes = await readCapped(res, url, budget);
      return {
        url: res.url || url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: Object.fromEntries(res.headers),
        body: (async function* () {
          yield bytes;
        })(),
      };
    },
  };
}

/** The origins a repository's fetches may reach: its host, and GitHub's archive host for GitHub's. */
function originsOf(spec: GitSpec): Set<string> {
  return new Set(spec.host === 'github' ? [spec.origin, 'https://codeload.github.com'] : [spec.origin]);
}

const refs = new Map<string, { sha: string; at: number }>();

/** The commit a spec names: its full id, the lockfile's, or the server's answer for its ref. */
async function resolveCommit(spec: GitSpec, label: string, offline: boolean, budget?: Budget): Promise<string> {
  if (spec.committish && FULL_SHA.test(spec.committish)) return spec.committish;
  const key = `${spec.url}#${spec.semver !== null ? `semver:${spec.semver}` : (spec.committish ?? '')}`;
  const known = refs.get(key);
  if (known && (offline || Date.now() - known.at < REF_TTL_MS)) return known.sha;
  if (offline) throw new Error(`git: ${label}: offline, and which commit it names is not known (pin a full commit id)`);
  const http = httpClient(originsOf(spec), budget);
  const list = async (prefix: string) => {
    try {
      return await git.listServerRefs({ http, url: spec.url, protocolVersion: 2, prefix, symrefs: true, peelTags: true });
    } catch (e) {
      const status = (e as { data?: { statusCode?: number } }).data?.statusCode;
      // A private repository answers as one that is not there (401 on GitHub): neither can be fetched.
      if (status === 401 || status === 403 || status === 404) throw appError(`git: ${label}: repository not found (HTTP ${status}) - ${spec.url}; only public repositories are fetched`);
      throw e;
    }
  };
  const commitOf = (r: { oid: string; peeled?: string }) => r.peeled ?? r.oid;
  let sha: string | undefined;
  if (spec.semver !== null) {
    const tags = (await list('refs/tags/')).filter((r) => !r.ref.endsWith('^{}'));
    const versions = new Map<string, (typeof tags)[number]>();
    for (const t of tags) {
      const v = semver.clean(t.ref.slice('refs/tags/'.length), { loose: true });
      if (v) versions.set(v, t);
    }
    const best = semver.maxSatisfying([...versions.keys()], spec.semver, { loose: true });
    if (!best) throw appError(`git: ${label}: no tag in semver:${spec.semver}`);
    sha = commitOf(versions.get(best)!);
  } else if (spec.committish === null) {
    sha = (await list('HEAD')).find((r) => r.ref === 'HEAD')?.oid;
    if (!sha) throw appError(`git: ${label}: the repository has no default branch`);
  } else {
    const c = spec.committish;
    const [heads, tags] = await Promise.all([list(`refs/heads/${c}`), list(`refs/tags/${c}`)]);
    const found = heads.find((r) => r.ref === `refs/heads/${c}`) ?? tags.find((r) => r.ref === `refs/tags/${c}`);
    if (found) sha = commitOf(found);
    else if (/^[0-9a-f]{7,39}$/.test(c)) throw appError(`git: ${label}: "${c}" is no branch or tag; give a commit by its full id (40 characters)`);
    else throw appError(`git: ${label}: no branch or tag named "${c}"`);
  }
  refs.set(key, { sha, at: Date.now() });
  return sha;
}

/** A file's content as a FileTree has it. */
const content = (data: Uint8Array): FileTree[string] => {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return isText(buf) ? buf.toString('utf8') : { base64: buf.toString('base64') };
};

/** Counts what a repository unpacks to, and stops one that is too large. */
function limiter(label: string, budget: Budget) {
  let files = 0;
  let bytes = 0;
  return (size: number) => {
    files++;
    bytes += size;
    budget.files++;
    budget.bytes += size;
    if (files > gitLimits.files || bytes > gitLimits.bytes) throw new UnsupportedDependencyError(`git: ${label}: the repository is too large to fetch (over ${gitLimits.files} files or ${gitLimits.bytes / 2 ** 20} MB)`);
    overBudget(label, budget);
  };
}

/** What one project's git fetches have unpacked so far, together: every fetch it runs at once counts into it as it goes. */
interface Budget {
  files: number;
  bytes: number;
  /** Bytes received (archives, packs), as they arrive. */
  received: number;
}

function overBudget(label: string, budget: Budget): void {
  if (budget.files > gitLimits.totalFiles || budget.bytes > gitLimits.totalBytes) throw new UnsupportedDependencyError(`git: ${label}: the project's git dependencies are too large together (over ${gitLimits.totalFiles} files or ${gitLimits.totalBytes / 2 ** 20} MB)`);
}

/** Whether a path of the repository is part of the package: not its git metadata, nor installed packages. */
const kept = (path: string) => !path.split('/').some((p) => p === '.git' || p === 'node_modules');

/** A commit's files from its host's archive (GitHub, GitLab, Bitbucket), or null when the host has no such archive. */
async function fromArchive(spec: GitSpec, sha: string, label: string, budget: Budget): Promise<FileTree | null> {
  const name = spec.path.split('/').pop()!;
  const url =
    spec.host === 'github'
      ? `https://codeload.github.com/${spec.path}/tar.gz/${sha}`
      : spec.host === 'gitlab'
        ? `${spec.origin}/${spec.path}/-/archive/${sha}/${name}-${sha}.tar.gz`
        : spec.host === 'bitbucket'
          ? `${spec.origin}/${spec.path}/get/${sha}.tar.gz`
          : null;
  if (!url) return null;
  const res = await hostFetch(url, originsOf(spec));
  if (res.status === 404) throw appError(`git: ${label}: commit ${sha} not found - ${spec.url}`);
  if (!res.ok) {
    await res.body?.cancel();
    return null; // the clone may still work
  }
  const count = limiter(label, budget);
  const gz = await readCapped(res, label, budget);
  const files: FileTree = {};
  let tar: Uint8Array;
  try {
    tar = gunzipSync(gz, { maxOutputLength: gitLimits.bytes });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new UnsupportedDependencyError(`git: ${label}: the repository is too large to fetch (over ${gitLimits.bytes / 2 ** 20} MB unpacked)`);
    throw e;
  }
  for (const f of untar(tar)) {
    if (!kept(f.path)) continue;
    count(f.data.length);
    files[f.path] = content(f.data);
  }
  return files;
}

/** A commit's files by a shallow fetch with isomorphic-git (a host without archives, or when its archive failed). */
async function fromClone(spec: GitSpec, sha: string, label: string, ref: string | null, budget: Budget): Promise<FileTree> {
  const tmp = await mkdtemp(join(cacheRoot(), '.clone-'));
  const http = httpClient(originsOf(spec), budget);
  try {
    await git.init({ fs, dir: tmp });
    await git.addRemote({ fs, dir: tmp, remote: 'origin', url: spec.url });
    // The commit by its id (most hosts serve any reachable one), else the ref that names it.
    // depth null: the whole history.
    const fetchOne = (remoteRef: string | undefined, depth: number | null = 1) => git.fetch({ fs, http, dir: tmp, remote: 'origin', remoteRef, singleBranch: true, depth: depth ?? undefined, tags: false });
    const has = () => git.readCommit({ fs, dir: tmp, oid: sha }).then(() => true, () => false);
    // A refusal (too large) is final; anything else, and the commit is looked for by its ref.
    await fetchOne(sha).catch((e: unknown) => {
      if (e instanceof UnsupportedDependencyError) throw e;
    });
    if (!(await has())) {
      // The ref that names it (a branch may have moved past a locked commit: then its history); for a
      // commit by its id, the branch or tag at it, else the default branch's history, which has it if anything does.
      const at = ref ? null : (await git.listServerRefs({ http, url: spec.url, protocolVersion: 2, prefix: 'refs/', peelTags: true })).find((r) => (r.peeled ?? r.oid) === sha && !r.ref.endsWith('^{}'));
      const remoteRef = ref ?? at?.ref;
      if (remoteRef) await fetchOne(remoteRef);
      if (!(await has())) await fetchOne(remoteRef, null);
    }
    const count = limiter(label, budget);
    const files: FileTree = {};
    await git.walk({
      fs,
      dir: tmp,
      trees: [git.TREE({ ref: sha })],
      map: async (path, [entry]) => {
        if (!entry || path === '.') return true;
        if (!kept(path)) return null;
        const type = await entry.type();
        if (type !== 'blob') return type === 'tree' ? true : null; // submodules are left out
        if ((await entry.mode()) === 0o120000) return null; // symlinks: npm packs none that matter
        const data = (await entry.content())!;
        count(data.length);
        files[path] = content(data);
        return true;
      },
    });
    return files;
  } catch (e) {
    if ((e as { code?: string }).code === 'NotFoundError') throw appError(`git: ${label}: commit ${sha} not found - ${spec.url}`);
    throw e;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Repositories' files by commit, in this process (a batch's projects often share one), with their sizes once known. */
const trees = new Map<string, { files: Promise<FileTree>; bytes: number }>();

/** The bytes a file tree holds (its strings). */
const treeBytes = (tree: FileTree) => Object.values(tree).reduce((n, c) => n + (typeof c === 'string' ? c.length : c.base64.length), 0);

/**
 * A response's body, refused past a repository's limit (by its length, or as it arrives) and, with
 * a budget, once the project's fetches have received more than theirs together: every response
 * the parallel fetches read counts into it as it arrives, not when it is done.
 */
async function readCapped(res: Response, label: string, budget?: Budget): Promise<Uint8Array> {
  const max = gitLimits.bytes;
  const tooLarge = () => new UnsupportedDependencyError(`git: ${label}: the repository is too large to fetch (a response over ${max / 2 ** 20} MB)`);
  const overTotal = () => budget && budget.received > gitLimits.totalBytes;
  const tooMuch = () => new UnsupportedDependencyError(`git: ${label}: the project's git dependencies are too large together (over ${gitLimits.totalBytes / 2 ** 20} MB received)`);
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  try {
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      size += next.value.length;
      if (budget) budget.received += next.value.length;
      if (size > max) throw tooLarge();
      if (overTotal()) throw tooMuch();
      parts.push(next.value);
    }
  } catch (e) {
    await reader?.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(parts);
}

/** A commit's files: from memory, the disk, the host's archive or a clone, in that order. */
function commitFiles(spec: GitSpec, sha: string, label: string, offline: boolean, budget: Budget): Promise<FileTree> {
  const id = `${spec.origin}/${spec.path}#${sha}`;
  let pending = trees.get(id)?.files;
  if (!pending) {
    pending = (async () => {
      const file = join(cacheRoot(), `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
      // Charged to the project's budget by its size before it is read: parallel reads of cached
      // repositories are bounded together, as downloads are.
      const size = await stat(file).then((st) => st.size, () => null);
      if (size !== null) {
        budget.received += size;
        if (budget.received > gitLimits.totalBytes) throw new UnsupportedDependencyError(`git: ${label}: the project's git dependencies are too large together (over ${gitLimits.totalBytes / 2 ** 20} MB read)`);
      }
      const cached = size === null ? null : await readFile(file, 'utf8').then((t) => JSON.parse(t) as FileTree, () => null);
      if (cached) return cached;
      if (offline) throw new Error(`git: ${label}: offline, and commit ${sha} has not been fetched before`);
      await mkdir(cacheRoot(), { recursive: true });
      const ref = spec.committish && !FULL_SHA.test(spec.committish) ? spec.committish : null;
      const files = (await fromArchive(spec, sha, label, budget)) ?? (await fromClone(spec, sha, label, ref, budget));
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
      await writeFile(tmp, JSON.stringify(files));
      await rename(tmp, file);
      return files;
    })();
    const entry = { files: pending, bytes: 0 };
    trees.set(id, entry);
    pending.then(
      (tree) => {
        entry.bytes = treeBytes(tree);
        // Bounded by bytes: the oldest go first (the disk still has them).
        let total = 0;
        for (const e of trees.values()) total += e.bytes;
        // The newest last: a tree over the cap on its own goes too (its project still has it).
        for (const [key, e] of trees) {
          if (total <= gitLimits.memoryBytes) break;
          total -= e.bytes;
          trees.delete(key);
        }
      },
      () => trees.delete(id),
    );
  }
  return pending;
}

/** The commit a project's package-lock.json records for a dependency at its root, if it is this repository. */
function lockedCommit(files: FileTree, name: string, spec: GitSpec, hosts: string[]): string | null {
  const text = files['package-lock.json'];
  if (typeof text !== 'string') return null;
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { resolved?: unknown; version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
    const entry = lock.packages?.[`node_modules/${name}`] ?? lock.dependencies?.[name];
    // A semver: range takes the locked commit only while the locked version is in it.
    if (spec.semver !== null && !(typeof entry?.version === 'string' && semver.valid(entry.version) && semver.satisfies(entry.version, spec.semver, { loose: true }))) return null;
    for (const value of [(entry as { resolved?: unknown })?.resolved, entry?.version]) {
      if (typeof value !== 'string') continue;
      const locked = parseGitSpec(value, hosts);
      if (locked && 'url' in locked && locked.url === spec.url && locked.committish && FULL_SHA.test(locked.committish)) return locked.committish;
    }
  } catch {
    // not JSON: npm reports it
  }
  return null;
}

/** A directory name for a package's files under .sandburg/git/. */
const dirOf = (spec: GitSpec, sha: string) => `${GIT_DIR}/${`${spec.origin.slice('https://'.length)}-${spec.path}`.replace(/[^\w.-]+/g, '-')}-${sha.slice(0, 12)}${spec.subdir ? `/${spec.subdir}` : ''}`;

/**
 * The project with its git dependencies' files: each git dependency the root, a workspace, a local
 * package or another git dependency names is fetched into `.sandburg/git/<repository>-<commit>/`
 * (a directory no project has: projectFromFiles leaves `.sandburg/` out), and `.sandburg/git.json`
 * maps its spec there, for the install plan to link (local-packages.ts). The project itself when it
 * names none.
 */
export async function withGitPackages(project: Project, options: { offline?: boolean; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<Project> {
  if (project.framework === 'static') return project;
  const hosts = extraGitHosts(process.env.SANDBURG_GIT_HOSTS);
  let files = project.files;
  const map: Record<string, string> = {};
  let count = 0;
  // What this call fetches, as it unpacks: the parallel fetches stop once they are over the project's budget together.
  const fetching: Budget = { files: 0, bytes: 0, received: 0 };
  // Given up on (options.signal): this call rejects at once. A fetch it started that other runs may
  // share goes on, bounded by its requests' timeouts, and is kept for them.
  const { signal } = options;
  const aborted = signal ? new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) : null;
  aborted?.catch(() => {});
  const until = <T>(p: Promise<T>): Promise<T> => (aborted ? Promise.race([p, aborted]) : p);
  let totalFiles = 0;
  let totalBytes = 0;
  for (;;) {
    signal?.throwIfAborted();
    // One fetch per spec, however many packages name it: the root's, if it names it (its lockfile's commit applies).
    const bySpec = new Map<string, InstallPlan['git'][number]>();
    for (const g of installPlan(files, project.packageJson, hosts).git) if (!bySpec.has(g.spec) || !g.dir) bySpec.set(g.spec, g);
    const pending = [...bySpec.values()];
    if (!pending.length) break;
    const added: FileTree = {};
    await Promise.all(
      pending.map(async ({ dir, name, spec: raw }) => {
        const spec = parseGitSpec(raw, hosts);
        if (!spec || !('url' in spec)) throw unsupportedDependency(name, raw, spec?.unsupported ?? 'not a git repository');
        if (++count > gitLimits.packages) throw unsupportedDependency(name, raw, `more than ${gitLimits.packages} git dependencies`);
        const label = `${name}@${raw}`;
        const started = Date.now();
        const sha = (!dir && !(spec.committish && FULL_SHA.test(spec.committish)) ? lockedCommit(files, name, spec, hosts) : null) ?? (await until(resolveCommit(spec, label, options.offline === true, fetching)));
        const tree = await until(commitFiles(spec, sha, label, options.offline === true, fetching));
        const at = dirOf(spec, sha);
        const prefix = spec.subdir ? `${spec.subdir}/` : '';
        let n = 0;
        for (const [path, data] of Object.entries(tree)) {
          if (!path.startsWith(prefix)) continue;
          added[`${at}/${path.slice(prefix.length)}`] = data;
          n++;
          totalBytes += typeof data === 'string' ? data.length : data.base64.length;
        }
        totalFiles += n;
        if (totalFiles > gitLimits.totalFiles || totalBytes > gitLimits.totalBytes) throw new UnsupportedDependencyError(`git: ${label}: the project's git dependencies are too large together (over ${gitLimits.totalFiles} files or ${gitLimits.totalBytes / 2 ** 20} MB)`);
        if (!n || typeof tree[`${prefix}package.json`] !== 'string') throw appError(`git: ${label}: no package.json at ${spec.subdir || 'the repository root'} (commit ${sha.slice(0, 12)})`);
        map[raw.trim()] = at;
        options.log?.(`git: ${label} → ${sha.slice(0, 12)} (${n} files, ${Date.now() - started} ms)${unprepared(tree, prefix)}`);
      }),
    );
    files = { ...files, ...added, [GIT_FILE]: JSON.stringify(map) };
  }
  if (files === project.files) return project;
  // The same project, with the fetched files (its package.json, framework and snapshot id as they were).
  return { ...project, files };
}

/**
 * A note for the log when a git package's entry point is not in the repository: npm would have run
 * its `prepare` script to build it, which the host does not (ADR 0054).
 */
function unprepared(tree: FileTree, prefix: string): string {
  try {
    const pkg = JSON.parse(tree[`${prefix}package.json`] as string) as { main?: unknown; scripts?: Record<string, unknown> };
    const main = typeof pkg.main === 'string' ? pkg.main.replace(/^\.\//, '') : null;
    const has = (p: string) => [p, `${p}.js`, `${p}/index.js`].some((x) => Object.hasOwn(tree, `${prefix}${x}`));
    if (main && !has(main) && pkg.scripts && (pkg.scripts.prepare || pkg.scripts.prepack || pkg.scripts.build)) return `; its main (${main}) is not in the repository, and its prepare script is not run`;
  } catch {
    // reported by the plan
  }
  return '';
}
