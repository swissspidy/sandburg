/**
 * A dev server's cache as the page reads it back to keep it for the next run (dispose in
 * adapters/node/browser.ts): a list of its files (path, size and mtime), which the page compares from
 * one look to the next to tell when webpack has finished storing its cache, and its bytes once, as a
 * bundle (the preload format: a little-endian u32 header length, a JSON header [[mode, path,
 * length], …], the bytes) in one transferred ArrayBuffer. It was the files as text, and binary
 * ones as base64, every 250 ms: ~2 s of the page's thread and ~0.9 s of the runtime's in a Next.js
 * seed run (ADR 0041).
 */
import type { Vfs } from './vfs.ts';

/** Files this large are left out (as they were from the text form). */
const FILE_MAX = 64 << 20;

/** A file of the cache: its project-relative path, size and mtime (a rewrite of the same length still changes it). */
export type CacheEntry = [path: string, size: number, mtimeMs: number];

/** The files under `dirs` (project-relative) in `root`; directories that are not there have none. */
export function listCache(vfs: Vfs, root: string, dirs: string[]): CacheEntry[] {
  const out: CacheEntry[] = [];
  const walk = (dir: string) => {
    for (const name of vfs.readdir(dir)) {
      const path = `${dir}/${name}`;
      const st = vfs.stat(path);
      if (st.kind === 'dir') walk(path);
      else if (st.size < FILE_MAX) out.push([path.slice(root.length + 1), st.size, st.mtimeMs]);
    }
  };
  for (const dir of dirs) {
    try {
      walk(`${root}/${dir}`);
    } catch {
      // not there
    }
  }
  return out;
}

/** The files of `entries` as a bundle, in one buffer (its sizes as read: a file may have changed since it was listed). */
export function bundleCache(vfs: Vfs, root: string, entries: CacheEntry[]): ArrayBuffer {
  const files: [string, Uint8Array][] = [];
  for (const [path] of entries) {
    try {
      files.push([path, vfs.read(`${root}/${path}`)]);
    } catch {
      // removed since
    }
  }
  const header = new TextEncoder().encode(JSON.stringify(files.map(([path, bytes]) => ['f', path, bytes.length])));
  const out = new Uint8Array(4 + header.length + files.reduce((n, [, bytes]) => n + bytes.length, 0));
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  let at = 4 + header.length;
  for (const [, bytes] of files) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out.buffer;
}
