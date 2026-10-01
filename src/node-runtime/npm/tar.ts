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
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'L') {
      longName = type === 'x' ? paxPath(data) : str(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(header, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(header, 0, 100)}` : str(header, 0, 100));
    longName = null;
    if (type !== '0' && type !== '7') continue; // directories, links, devices
    // Normalized: some packages are packed with "./" or "//" inside their paths, which would
    // otherwise become directories named "." or "" (a directory that lists itself).
    const segments = name.split(/\/+/).filter((s) => s && s !== '.');
    segments.shift();
    if (!segments.length || segments.includes('..')) continue;
    files.push({ path: segments.join('/'), mode: octal(header, 100, 8), data });
  }
  return files;
}
