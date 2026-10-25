/**
 * Dev servers' caches kept between runs of a project, and the capabilities that let a run's page
 * store one (a token for one key, from one sandbox, once) or record the host's compiles.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../../types.ts';
import { CompileCache } from './compile-cache.ts';
import { tmpSuffix } from './install.ts';
import { devCacheRoot } from './installs.ts';

/**
 * Dev servers' dependency caches, kept between runs: Vite's cache directory, with each environment's
 * pre-bundled dependencies (deps, deps_ssr) and what plugins keep beside them (without
 * vite-plugin-svelte's _svelte_metadata.json, SvelteKit re-optimized on every start), where Vite
 * (node_modules/.vite), Nuxt (node_modules/.cache/vite) and the Angular CLI (.angular/cache) put it.
 * Vite checks that a cache matches the lockfile and its config before it uses one, so a stale cache
 * costs a re-optimization, not a wrong result. Also jiti's (node_modules/.cache/jiti: the config
 * files it compiled, nuxt.config.ts, under a hash of their source), which spares a warm run loading
 * jiti's Babel, and the runtime's transform cache (node_modules/.vite/sandburg-transforms). A run writes its cache from the page, which runs the
 * project's code, so a cache is only ever used by runs of the same project (its installed packages
 * and every file): one project cannot plant pre-bundled code in another's run.
 */
export const DEV_CACHE_DIRS = ['node_modules/.vite', 'node_modules/.cache/vite', 'node_modules/.cache/jiti', '.angular/cache'];

export function devCacheKey(project: Project, installKey: string): string {
  const h = createHash('sha256').update(installKey);
  for (const path of Object.keys(project.files).sort()) {
    const content = project.files[path];
    h.update(path).update('\0').update(typeof content === 'string' ? content : JSON.stringify(content)).update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * Write capabilities issued to runs, by token: a random token handed to one run's page with its
 * install data, for one cache key and the sandbox (origin) that run is in. A cache key is a digest of
 * what a run installs and runs, which another run can know (a seed's key is a digest of public
 * versions, and later runs learn it from their bundle URL), so the key alone never grants a write:
 * a store needs the token, from the run's own sandbox, once. What the page sends is untrusted, and is
 * kept only under the key's directories.
 */
interface CacheWrite {
  key: string;
  dirs: string[];
  /** The sandbox of the run the token was issued to, once its tab is known (HostInstallOptions.sandbox). */
  sandbox: string | null;
}

const cacheWrites = new Map<string, CacheWrite>();

/** Compile-cache capabilities (see compile-cache.ts), by token: many records per run, from its sandbox only. */
export const compileWrites = new Map<string, { key: string; sandbox: string | null }>();

/** Tokens are dropped after this long unused (the longest run's deadlines are well under it). */
export const TOKEN_TTL_MS = 6 * 60 * 60_000;

export const DEV_CACHE_MAX = 256 << 20;

/** The largest code the runtime sends to compile, or sources to scan (next dev's largest chunks are ~8 MB). */
export const SOURCE_BODY_MAX = 32 << 20;

/** A new capability token for the run whose page will be in `sandbox` (bound once its tab is known). */
function issue<T extends { sandbox: string | null }>(into: Map<string, T>, grant: T, sandbox: Promise<string> | undefined): string {
  const token = randomBytes(32).toString('base64url');
  into.set(token, grant);
  void sandbox?.then((id) => (grant.sandbox = id), () => {});
  setTimeout(() => into.delete(token), TOKEN_TTL_MS).unref();
  return token;
}

/** A capability to store a cache under `key` (files under `dirs`), once, for the run whose page will be in `sandbox`. */
export function issueCacheWrite(key: string, dirs: string[], sandbox: Promise<string> | undefined): string {
  return issue(cacheWrites, { key, dirs, sandbox: null }, sandbox);
}

/** A capability to record compiles under the dev-cache `key`, for the run whose page will be in `sandbox`. */
export function issueCompileWrite(key: string, sandbox: Promise<string> | undefined): string {
  compileKeys.add(key);
  return issue(compileWrites, { key, sandbox: null }, sandbox);
}

/** The grant for a request's token, if it was issued for `key` to the requesting sandbox. */
export function granted<T extends { key: string; sandbox: string | null }>(from: Map<string, T>, token: string | null | undefined, key: string, sandbox: string | undefined): T | null {
  const grant = token ? from.get(token) : undefined;
  return grant && grant.key === key && grant.sandbox !== null && grant.sandbox === sandbox ? grant : null;
}

/** The entries of a cache that are text files under `dirs`. */
export function cacheEntries(value: unknown, dirs: string[]): Record<string, string | { base64: string }> {
  const out: Record<string, string | { base64: string }> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [path, content] of Object.entries(value)) {
    // Text, or binary as { base64 } (webpack's cache packs).
    const file = typeof content === 'string' || (!!content && typeof content === 'object' && Object.keys(content).length === 1 && typeof (content as { base64?: unknown }).base64 === 'string');
    if (!file || path.split('/').includes('..')) continue;
    if (dirs.some((d) => path.startsWith(`${d}/`))) out[path] = content;
  }
  return out;
}

export async function readDevCache(key: string, dirs: string[]): Promise<Record<string, string | { base64: string }>> {
  try {
    return cacheEntries(JSON.parse(await readFile(join(devCacheRoot(), `${key}.json`), 'utf8')), dirs);
  } catch {
    return {};
  }
}

/** The SHA-256 (hex) of each file of a cache, as the page computes it over what a run leaves (browser.ts). */
export function cacheDigests(files: Record<string, string | { base64: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = createHash('sha256').update(typeof content === 'string' ? Buffer.from(content) : Buffer.from(content.base64, 'base64')).digest('hex');
  }
  return out;
}

/** What the host compiled for runs, by dev-cache key (see compile-cache.ts); keys issued to runs. */
export const compileCache = new CompileCache(devCacheRoot);

export const compileKeys = new Set<string>();

/** Caches handed to runs to start from, and the directories they may hold (see cacheBundle). */
export const readableCaches = new Map<string, string[]>();

/**
 * A stored cache as a bundle (the preload format: u32 header length, JSON [[mode, path, length], …],
 * bytes): the worker fetches it itself, instead of tens of megabytes of base64 in the install data.
 */
export async function cacheBundle(key: string): Promise<Buffer | null> {
  const dirs = readableCaches.get(key);
  if (!dirs) return null;
  const json = join(devCacheRoot(), `${key}.json`);
  const bin = `${json}.bin`;
  const [jsonStat, binStat] = await Promise.all([stat(json).catch(() => null), stat(bin).catch(() => null)]);
  if (!jsonStat) return null;
  if (binStat && binStat.mtimeMs >= jsonStat.mtimeMs) return readFile(bin);
  const header: [string, string, number][] = [];
  const bodies: Buffer[] = [];
  for (const [path, content] of Object.entries(await readDevCache(key, dirs))) {
    const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content.base64, 'base64');
    header.push(['f', path, body.length]);
    bodies.push(body);
  }
  const head = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(head.length);
  const bundle = Buffer.concat([length, head, ...bodies]);
  const tmp = `${bin}.${tmpSuffix()}.tmp`;
  await writeFile(tmp, bundle);
  await rename(tmp, bin);
  return bundle;
}

/**
 * Whether the request may store a cache under `key`: its token was issued for that key to the
 * requesting sandbox (see cacheWrites). The token is withdrawn here, before the body is read (restored
 * if the write fails), so it takes one write.
 */
export function takeCacheWrite(key: string, token: string | null | undefined, sandbox: string | undefined): (CacheWrite & { token: string }) | null {
  const grant = granted(cacheWrites, token, key, sandbox);
  if (!grant) return null;
  cacheWrites.delete(token!);
  return { ...grant, token: token! };
}

/**
 * The files of a cache the page sends as a bundle (the preload format: u32 header length, JSON
 * header [[mode, path, length], …], the bytes; see node-runtime/cache-tree.ts), as the stored form
 * has them: UTF-8 text, or binary as { base64 }. Null if it is not one: a header that is not a list
 * of files, or whose lengths do not add up to the body's.
 */
export function bundledEntries(body: Buffer): Record<string, string | { base64: string }> | null {
  if (body.length < 4) return null;
  const length = body.readUInt32LE(0);
  if (4 + length > body.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(body.subarray(4, 4 + length).toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(header)) return null;
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const out: Record<string, string | { base64: string }> = {};
  let at = 4 + length;
  for (const entry of header as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[1] !== 'string' || !Number.isSafeInteger(entry[2]) || entry[2] < 0 || at + entry[2] > body.length) return null;
    const bytes = body.subarray(at, at + entry[2]);
    at += entry[2];
    let text: string | null = null;
    try {
      text = utf8.decode(bytes);
    } catch {
      // binary (webpack's cache packs)
    }
    out[entry[1]] = text ?? { base64: bytes.toString('base64') };
  }
  return at === body.length ? out : null;
}

export async function writeDevCache(grant: CacheWrite & { token: string }, body: (max: number) => Promise<Buffer>, binary = false): Promise<boolean> {
  const { key, dirs } = grant;
  const restore = () => cacheWrites.set(grant.token, { key, dirs, sandbox: grant.sandbox });
  // A body over the limit is answered by the host server (a 413).
  const text = await body(DEV_CACHE_MAX).catch((err: unknown) => {
    restore();
    throw err;
  });
  try {
    // A bundle (the page's form), or JSON: path → text or { base64 }. Only files under the grant's directories are kept.
    const sent: unknown = binary ? bundledEntries(text) : JSON.parse(text.toString('utf8'));
    if (sent === null) throw new Error('not a bundle of files');
    const files = cacheEntries(sent, dirs);
    await mkdir(devCacheRoot(), { recursive: true });
    const file = join(devCacheRoot(), `${key}.json`);
    const tmp = `${file}.${tmpSuffix()}.tmp`;
    await writeFile(tmp, JSON.stringify(files));
    await rename(tmp, file);
    return true;
  } catch {
    restore();
    return false;
  }
}
