/**
 * What the host compiled for a project's runtimes (POST /__sandburg/compile: code the runtime did not
 * get transformed with the install, compileForRuntime), kept for the project's next run. Vite's SSR
 * module runner evaluates each server module with `new AsyncFunction(body)`, whose body the runtime
 * has the host lower (see worker.ts): one synchronous request each, ~12 ms on a busy machine, and
 * Astro's dev server evaluates ~340 modules before its first page. A run gets a bundle of what earlier
 * runs of its project compiled and looks a compile up there first.
 *
 * Kept per dev-cache key (the project's files and its install, see devCacheKey in index.ts), so a
 * run gets only what runs of the same project sent. Each entry is the host's own output for the code
 * it was sent, and a lookup matches the whole code: a run can add entries, not change what another
 * code compiles to.
 */
import { createHash } from 'node:crypto';
import { version as esbuildVersion } from 'esbuild';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { source } from '../../sources.ts';
import { tmpSuffix } from './install.ts';
import type { CompileKind } from './compile.ts';
import { bundleHead, bundleHeader } from '../../bundle-format.ts';

/** What the stored outputs depend on besides the code: the compiler's own sources, and the esbuild it runs. */
export function compilerKey(esbuildVersion: string): string {
  return createHash('sha256')
    .update([...['compile.ts', 'interop.ts', 'tla.ts', 'esm-names.ts'].map((f) => `adapters/node/${f}`), 'node-runtime/await-context.ts', 'node-runtime/names.ts'].map((f) => readFileSync(source(f), 'utf8')).join('\0'))
    .update(`\0esbuild ${esbuildVersion}`)
    .digest('hex')
    .slice(0, 12);
}
export const COMPILER = compilerKey(esbuildVersion);

/**
 * Code this large is not kept: the runtime asks for it by digest first (ASK_FIRST in worker.ts), and
 * next dev's chunks made a Next.js app's bundle 27 MB, which the runtime decoded at its first compile.
 */
export const MAX_CODE = 1 << 18;

/** A project's stored compiles are at most this large (code and output); older runs' go first. */
const MAX_BYTES = 48 << 20;
/** Projects whose compiles are kept in memory (a batch runs many; each is loaded again from its file). */
const KEYS_KEPT = 8;

interface Entry {
  kind: CompileKind;
  async: boolean;
  path: string;
  code: Buffer;
  out: Buffer;
  /** Compiled in this process (not loaded from an earlier one's file). */
  fresh: boolean;
}

export class CompileCache {
  private keys = new Map<string, Promise<Map<string, Entry>>>();
  private bytes = new Map<string, number>();
  private dirty = new Set<string>();
  private flushing: ReturnType<typeof setTimeout> | null = null;
  private bundles = new Map<string, Buffer>();
  /** Keys whose entries are all in their file (read from it, or written to it): kept while the file is (see has). */
  private stored = new Set<string>();
  private dir: () => string;

  constructor(dir: () => string) {
    this.dir = dir;
  }

  private file(key: string): string {
    return join(this.dir(), `compiled-${COMPILER}-${key}.bin`);
  }

  private load(key: string): Promise<Map<string, Entry>> {
    let entries = this.keys.get(key);
    if (entries) {
      // Used last: kept longest.
      this.keys.delete(key);
      this.keys.set(key, entries);
    } else {
      // A file that is missing, or that does not parse (parse() throws), counts as none.
      entries = readFile(this.file(key))
        .then((bundle) => {
          const map = new Map<string, Entry>();
          let size = 0;
          for (const e of parse(bundle)) {
            map.set(id(e.kind, e.async, e.path, e.code), e);
            size += e.code.length + e.out.length;
          }
          this.bytes.set(key, size);
          this.stored.add(key);
          return map;
        })
        .catch(() => new Map<string, Entry>());
      this.keys.set(key, entries);
      for (const old of this.keys.keys()) {
        if (this.keys.size <= KEYS_KEPT) break;
        if (this.dirty.has(old)) continue;
        this.drop(old);
      }
    }
    return entries;
  }

  private drop(key: string): void {
    this.keys.delete(key);
    this.bytes.delete(key);
    this.bundles.delete(key);
    this.stored.delete(key);
  }

  /**
   * Whether earlier runs of the project compiled anything. Compiles kept in memory whose file was
   * removed since (.sandburg cleared while the process kept running) are written again: each is the
   * host's output for its code and this compiler, as true as before.
   */
  async has(key: string): Promise<boolean> {
    if (this.stored.has(key) && !this.dirty.has(key) && !(await access(this.file(key)).then(() => true, () => false))) {
      if (this.stored.delete(key)) {
        this.dirty.add(key);
        this.flushing ??= setTimeout(() => void this.flush(), 2000);
      }
    }
    return (await this.load(key)).size > 0;
  }

  /** The stored compiles as a bundle: u32 header length (LE), JSON [[kind, async, path, code length, output length], …], then each code and output. */
  async bundle(key: string): Promise<Buffer | null> {
    const cached = this.bundles.get(key);
    if (cached) return cached;
    const entries = [...(await this.load(key)).values()];
    if (!entries.length) return null;
    const bundle = Buffer.concat([bundleHead(entries.map((e) => [e.kind, e.async ? 1 : 0, e.path, e.code.length, e.out.length])), ...entries.flatMap((e) => [e.code, e.out])]);
    this.bundles.set(key, bundle);
    return bundle;
  }

  async record(key: string, kind: CompileKind, async: boolean, path: string, code: string, out: string): Promise<void> {
    if (code.length >= MAX_CODE) return;
    const entries = await this.load(key);
    const k = id(kind, async, path, Buffer.from(code));
    if (entries.has(k)) return;
    const entry: Entry = { kind, async, path, code: Buffer.from(code), out: Buffer.from(out), fresh: true };
    const size = entry.code.length + entry.out.length;
    let total = (this.bytes.get(key) ?? 0) + size;
    // Older runs' compiles make room first (code the project no longer has), then nothing is added.
    for (const [old, e] of entries) {
      if (total <= MAX_BYTES) break;
      if (e.fresh) continue;
      entries.delete(old);
      total -= e.code.length + e.out.length;
    }
    if (total > MAX_BYTES) return;
    entries.set(k, entry);
    this.bytes.set(key, total);
    this.bundles.delete(key);
    this.stored.delete(key);
    this.dirty.add(key);
    this.flushing ??= setTimeout(() => void this.flush(), 2000);
  }

  /** Writes what was recorded since the last write (2 s after a record). */
  async flush(): Promise<void> {
    if (this.flushing) clearTimeout(this.flushing);
    this.flushing = null;
    // Called from a timer: a failure only loses what the next run would have reused.
    if (!(await mkdir(this.dir(), { recursive: true }).then(() => true, () => false))) return;
    for (const key of [...this.dirty]) {
      this.dirty.delete(key);
      const bundle = await this.bundle(key);
      if (!bundle) continue;
      const file = this.file(key);
      const tmp = `${file}.${tmpSuffix()}.tmp`;
      await writeFile(tmp, bundle)
        .then(() => rename(tmp, file))
        .then(() => {
          if (!this.dirty.has(key)) this.stored.add(key);
        })
        .catch(() => {});
    }
  }
}

function id(kind: string, async: boolean, path: string, code: Buffer): string {
  return createHash('sha256').update(`${kind}\0${async ? 1 : 0}\0${path}\0`).update(code).digest('hex');
}

/** A stored bundle's entries; throws for one that is cut off or is not a bundle. */
function parse(bundle: Buffer): Entry[] {
  const { header, body } = bundleHeader<[CompileKind, number, string, number, number]>(bundle);
  if (body + header.reduce((n, e) => n + e[3] + e[4], 0) !== bundle.length) throw new Error('not a compile bundle');
  const out: Entry[] = [];
  let at = body;
  for (const [kind, async, path, codeLength, outLength] of header) {
    const code = bundle.subarray(at, at + codeLength);
    at += codeLength;
    out.push({ kind, async: !!async, path, code, out: bundle.subarray(at, at + outLength), fresh: false });
    at += outLength;
  }
  return out;
}
