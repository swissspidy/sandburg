/**
 * Content-addressed snapshot store (ADR 0002).
 *
 * A blob is a file's bytes, stored under its sha256. A snapshot is a manifest
 * of path → blob hash; its id is the sha256 of the canonical manifest, so the
 * same file tree always has the same id, whatever its source. Runs record the
 * snapshot id, which makes "load snapshot X in a tab" possible later.
 *
 * Layout: <root>/blobs/ab/<sha256>, <root>/snapshots/<id>.json
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileContent, FileTree } from './types.ts';

export interface SnapshotManifest {
  /** Path → sha256 of the file's bytes. */
  files: Record<string, string>;
}

export interface SnapshotRecord extends SnapshotManifest {
  id: string;
  /** Informational; not part of the id. First writer wins. */
  name: string;
  createdAt: string;
}

export const SNAPSHOT_ID = /^[0-9a-f]{64}$/;

export function contentBytes(content: FileContent): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content.base64, 'base64');
}

export function blobHash(content: FileContent): string {
  return createHash('sha256').update(contentBytes(content)).digest('hex');
}

export function manifestOf(files: FileTree): SnapshotManifest {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) out[path] = blobHash(files[path]);
  return { files: out };
}

/** Snapshot id: sha256 over "path\0blob\n" lines in sorted path order. */
export function snapshotId(manifest: SnapshotManifest): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(manifest.files).sort()) hash.update(`${path}\0${manifest.files[path]}\n`);
  return hash.digest('hex');
}

export class SnapshotStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(files: FileTree, name: string): Promise<string> {
    const manifest = manifestOf(files);
    const id = snapshotId(manifest);
    const recordPath = join(this.root, 'snapshots', `${id}.json`);
    if (await exists(recordPath)) return id;
    for (const [path, hash] of Object.entries(manifest.files)) {
      const blobPath = this.blobPath(hash);
      if (!(await exists(blobPath))) await atomicWrite(blobPath, contentBytes(files[path]));
    }
    const record: SnapshotRecord = { id, name, createdAt: new Date().toISOString(), files: manifest.files };
    await atomicWrite(recordPath, JSON.stringify(record, null, 2) + '\n');
    return id;
  }

  /** Resolves a full id or a unique prefix (≥ 8 hex chars). */
  async resolve(ref: string): Promise<string> {
    if (SNAPSHOT_ID.test(ref)) return ref;
    if (!/^[0-9a-f]{8,63}$/.test(ref)) throw new Error(`not a snapshot id: ${ref}`);
    const names = await readdir(join(this.root, 'snapshots')).catch(() => [] as string[]);
    const matches = names.filter((n) => n.startsWith(ref)).map((n) => n.replace(/\.json$/, ''));
    if (matches.length !== 1) throw new Error(`snapshot ${ref}: ${matches.length === 0 ? 'not found' : 'ambiguous'}`);
    return matches[0];
  }

  async get(ref: string): Promise<{ record: SnapshotRecord; files: FileTree }> {
    const id = await this.resolve(ref);
    const record = JSON.parse(await readFile(join(this.root, 'snapshots', `${id}.json`), 'utf8')) as SnapshotRecord;
    const files: FileTree = {};
    for (const [path, hash] of Object.entries(record.files)) {
      const buf = await readFile(this.blobPath(hash));
      if (createHash('sha256').update(buf).digest('hex') !== hash) throw new Error(`corrupt blob ${hash} (${path})`);
      files[path] = isText(buf) ? buf.toString('utf8') : { base64: buf.toString('base64') };
    }
    return { record, files };
  }

  private blobPath(hash: string): string {
    return join(this.root, 'blobs', hash.slice(0, 2), hash);
  }
}

export function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
