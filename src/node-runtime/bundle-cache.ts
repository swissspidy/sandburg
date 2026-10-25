/**
 * The runtime's scripts as esbuild built them, kept on disk (.sandburg/bundles) by what they were
 * built from. Every process built them anew: ~0.1 s for the runtime's script and ~0.3 s for its
 * libraries (four builds at once), beside a run's install, for each `sandburg run`.
 *
 * An entry holds the digest of each file the build read (esbuild's metafile), of the package.json of
 * each package those come from, and the output. It is used while every one of those files still has
 * its digest, under the same esbuild version and build (`salt`: the build's own code and options);
 * else the script is built again and the entry replaced.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { version as esbuildVersion, type Metafile } from 'esbuild';

/** Where entries are kept (beside the installs, as the host's other caches). */
export const bundleCacheDir = (): string => resolve(process.env.SANDBURG_INSTALL_DIR ?? '.sandburg/installs', '..', 'bundles');

interface Entry {
  /** Digest of each file read, by its path relative to the build's working directory. */
  inputs: Record<string, string>;
  text: string;
}

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * The files whose digests an entry keeps: the build's inputs (on disk), their packages' package.json,
 * and the TypeScript configuration esbuild applies to them (the nearest tsconfig.json or
 * jsconfig.json, and what it extends): its target and class-field and import settings change the output.
 */
function files(metafile: Metafile, root: string): string[] {
  const out = new Set<string>();
  const configs = new Map<string, string | null>();
  for (const path of Object.keys(metafile.inputs)) {
    // A plugin's virtual module (namespace:path) or stdin is the build's own: part of its salt.
    if (/^[a-z-]+:/.test(path) || path === '<stdin>' || !existsSync(join(root, path))) continue;
    out.add(path);
    const pkg = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (pkg && existsSync(join(root, pkg[1], 'package.json'))) out.add(`${pkg[1]}/package.json`);
    for (const config of tsconfigsOf(dirname(join(root, path)), root, configs)) out.add(config);
  }
  return [...out].sort();
}

/** The tsconfig.json or jsconfig.json nearest `dir` (within `root`), and the files it extends, relative to `root`. */
function tsconfigsOf(dir: string, root: string, nearest: Map<string, string | null>): string[] {
  const found: string[] = [];
  let at: string | null = dir;
  const visited: string[] = [];
  let config: string | null = null;
  while (at !== null) {
    if (nearest.has(at)) {
      config = nearest.get(at)!;
      break;
    }
    visited.push(at);
    config = ['tsconfig.json', 'jsconfig.json'].map((name) => join(at!, name)).find((file) => existsSync(file)) ?? null;
    if (config) break;
    const up = dirname(at);
    at = up === at || relative(root, up).startsWith('..') ? null : up;
  }
  for (const d of visited) nearest.set(d, config);
  // An `extends` that names a file (not a package's configuration) is read too.
  for (let file = config, depth = 0; file && depth < 8; depth++) {
    const rel = relative(root, file);
    if (rel.startsWith('..') || found.includes(rel)) break;
    found.push(rel);
    let extended: unknown;
    try {
      extended = (JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { extends?: unknown }).extends;
    } catch {
      break;
    }
    file = typeof extended === 'string' && extended.startsWith('.') ? resolve(dirname(file), extended.endsWith('.json') ? extended : `${extended}.json`) : null;
  }
  return found;
}

/**
 * A build's output text, from the cache if its inputs are unchanged, else from `build` (which must
 * ask esbuild for a metafile), stored for the next process. `transform` makes the text that is kept
 * from esbuild's (and is part of the build: its code belongs in `salt`).
 */
export async function cachedBuild(
  name: string,
  salt: string,
  root: string,
  build: () => Promise<{ outputFiles?: { text: string }[]; metafile?: Metafile }>,
  transform: (text: string) => string | Promise<string> = (t) => t,
  dir = bundleCacheDir(),
): Promise<string> {
  const file = join(dir, `${name}-${digest(`${esbuildVersion}\0${salt}`).slice(0, 24)}.json`);
  const stored = await readFile(file, 'utf8')
    .then((s) => JSON.parse(s) as Entry)
    .catch(() => null);
  if (stored && typeof stored.text === 'string' && stored.inputs && typeof stored.inputs === 'object') {
    const paths = Object.keys(stored.inputs);
    const now = await Promise.all(paths.map((p) => readFile(join(root, p)).then(digest, () => null)));
    if (paths.length && now.every((d, i) => d === stored.inputs[paths[i]])) return stored.text;
  }
  const result = await build();
  if (!result.outputFiles?.[0] || !result.metafile) throw new Error(`cachedBuild(${name}): the build must write no files and return a metafile`);
  const text = await transform(result.outputFiles[0].text);
  const inputs: Record<string, string> = {};
  for (const p of files(result.metafile, root)) inputs[p] = digest(await readFile(join(root, p)));
  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify({ inputs, text } satisfies Entry));
    await rename(tmp, file);
    // The script's entries for other builds (an earlier version of Sandburg or esbuild) go.
    for (const old of await readdir(dir)) if (old.startsWith(`${name}-`) && old.endsWith('.json') && join(dir, old) !== file) await rm(join(dir, old), { force: true });
  } catch {
    // not kept (a read-only directory): built again next time
  }
  return text;
}
