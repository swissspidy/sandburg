/**
 * Reads the tar archives npm packages are published as (after gunzip): ustar headers, with the long
 * names of pax extended headers ('x') and GNU long-name entries ('L'). Regular files only (npm
 * packs no links that matter to an install); directories are implied by the files' paths.
 */
export interface TarFile {
  /** Path inside the archive, without its first segment ("package/" in npm tarballs). */
  path: string;
  mode: number;
  data: Uint8Array;
}

const decoder = new TextDecoder();

function str(block: Uint8Array, at: number, length: number): string {
  const bytes = block.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(block: Uint8Array, at: number, length: number): number {
  const text = str(block, at, length).trim();
  return text ? parseInt(text, 8) : 0;
}

/** pax records ("<length> <key>=<value>\n", the length in bytes): the path, if one is given. */
function paxPath(data: Uint8Array): string | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(decoder.decode(data.subarray(at, space)));
    if (!length) break;
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') return record.slice(eq + 1);
    at += length;
  }
  return null;
}

export function untar(archive: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  const state = { longName: null as string | null };
  let at = 0;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    const file = entry(header, data, state);
    if (file) files.push(file);
  }
  return files;
}

/** One archive entry: a regular file, or null (a long name for the next entry is kept in `state`). */
function entry(header: Uint8Array, data: Uint8Array, state: { longName: string | null }): TarFile | null {
  const type = String.fromCharCode(header[156] || 48);
  if (type === 'x' || type === 'L') {
    state.longName = type === 'x' ? paxPath(data) : str(data, 0, data.length);
    return null;
  }
  if (type === 'g') return null;
  const prefix = str(header, 345, 155);
  const name = state.longName ?? (prefix ? `${prefix}/${str(header, 0, 100)}` : str(header, 0, 100));
  state.longName = null;
  if (type !== '0' && type !== '7') return null; // directories, links, devices
  // Normalized: some packages are packed with "./" or "//" inside their paths, which would
  // otherwise become directories named "." or "" (a directory that lists itself).
  const segments = name.split(/\/+/).filter((s) => s && s !== '.');
  segments.shift();
  if (!segments.length || segments.includes('..')) return null;
  return { path: segments.join('/'), mode: octal(header, 100, 8), data };
}

/**
 * untar() for an archive that arrives in pieces (from a gunzip stream): push() returns the files
 * completed so far, so a large archive is never held whole.
 */
export class TarReader {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private header: Uint8Array | null = null;
  private size = 0;
  private ended = false;
  private state = { longName: null as string | null };

  push(chunk: Uint8Array): TarFile[] {
    const files: TarFile[] = [];
    if (this.ended) return files;
    this.chunks.push(chunk);
    this.length += chunk.length;
    for (;;) {
      if (!this.header) {
        if (this.length < 512) break;
        const header = this.take(512);
        if (header.every((b) => b === 0)) {
          this.ended = true;
          this.chunks = [];
          break;
        }
        this.header = header;
        this.size = octal(header, 124, 12);
      }
      const padded = Math.ceil(this.size / 512) * 512;
      if (this.length < padded) break;
      const data = this.take(padded).subarray(0, this.size);
      const file = entry(this.header, data, this.state);
      this.header = null;
      if (file) files.push(file);
    }
    return files;
  }

  /** The next n bytes (a view when one chunk has them). */
  private take(n: number): Uint8Array {
    if (!n) return new Uint8Array(0);
    this.length -= n;
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const part = Math.min(c.length, n - at);
      out.set(c.subarray(0, part), at);
      at += part;
      if (part === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(part);
    }
    return out;
  }
}
