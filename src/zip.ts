/**
 * Minimal zip reader for project input: reads the central directory and
 * inflates entries with node:zlib. Supports stored and deflated entries
 * (what every common zip tool writes); rejects encryption, zip64 and paths
 * that escape the project root.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Uncompressed size limit for a whole archive, against zip bombs. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('zip64 archives are not supported');

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('corrupt zip: bad central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.replace(/\\/g, '/').split('/').includes('..')) {
      throw new Error(`zip entry path escapes project root: ${name}`);
    }
    if (flags & 0x1) throw new Error(`encrypted zip entries are not supported: ${name}`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('zip expands beyond 256 MB');

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`corrupt zip: bad local header for ${name}`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: size || 1 });
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`corrupt zip: size mismatch for ${name}`);
    entries.push({ path: name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD record is 22 bytes plus a comment of up to 64 KiB, at the end of the file.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip archive (no end of central directory)');
}

/**
 * Zips downloaded from GitHub and most "compress folder" tools wrap everything
 * in one top-level directory; drop it so package.json lands at the root.
 */
export function stripCommonRoot(entries: ZipEntry[]): ZipEntry[] {
  const firsts = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
  if (firsts.size !== 1 || firsts.has('')) return entries;
  const root = [...firsts][0] + '/';
  return entries.map((e) => ({ path: e.path.slice(root.length), data: e.data }));
}
