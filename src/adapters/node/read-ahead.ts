/**
 * Files sent ahead: with a file the runtime asks for, the files after it in its directory (read
 * ahead), and the files a module will require next (pushed ahead).
 */
import type { FileIndex } from './install.ts';
import { Prefetcher } from './prefetch.ts';
import { installer } from './installs.ts';
import { preloadList, BUNDLES_KEPT } from './preload.ts';
import { bundleHead } from '../../bundle-format.ts';

/**
 * Read-ahead of raw installed files: a runtime that reads a raw file missing from its preload bundle
 * asks for it with `?ahead=1`, and gets a bundle (status 207, the preload format) of that file and the
 * files after it in its directory, by name: a dev server's first pre-bundle reads a package's files in
 * turn (Vite's esbuild read lucide-react's icons and their source maps, 3,100 requests). Files this
 * install's runs loaded before are left out (they are in its preload bundle), as are large ones;
 * the answer stays under the file channel's MAX_BODY (src/file-channel.ts). The runtime tells
 * which ones it read (`?used=1`), and only those are recorded as loaded.
 */
const AHEAD_BUDGET = 512 << 10;

const AHEAD_FILE_MAX = 64 << 10;

const AHEAD_FILES = 512;

/** File names by directory, sorted, per install. */
const directories = new Map<string, Promise<Map<string, string[]>>>();

function directoriesOf(key: string): Promise<Map<string, string[]>> {
  let dirs = directories.get(key);
  if (!dirs) {
    dirs = installer.index(key).then((index) => {
      const out = new Map<string, string[]>();
      for (const rel of Object.keys(index)) {
        const at = rel.lastIndexOf('/');
        const list = out.get(rel.slice(0, at));
        if (list) list.push(rel.slice(at + 1));
        else out.set(rel.slice(0, at), [rel.slice(at + 1)]);
      }
      for (const list of out.values()) list.sort();
      return out;
    });
    directories.set(key, dirs);
    for (const old of directories.keys()) if (directories.size > BUNDLES_KEPT) directories.delete(old);
  }
  return dirs;
}

/**
 * The read-ahead answer for raw `rel` (its bytes `first`): the files after it, up to the name
 * `until` (the runtime has the files from there), or null when nothing comes with it.
 */
export async function readAhead(key: string, rel: string, first: Buffer, until: string | null): Promise<Buffer | null> {
  if (first.length >= AHEAD_BUDGET) return null;
  const at = rel.lastIndexOf('/');
  const names = (await directoriesOf(key)).get(rel.slice(0, at)) ?? [];
  const index = await installer.index(key);
  const loaded = await preloadList(key);
  const header: [string, string, number][] = [['f', rel, first.length]];
  const bodies: Buffer[] = [first];
  let bytes = first.length;
  for (let i = names.indexOf(rel.slice(at + 1)) + 1; i > 0 && i < names.length && header.length < AHEAD_FILES; i++) {
    if (until !== null && names[i] >= until) break;
    const next = `${rel.slice(0, at)}/${names[i]}`;
    const size = index[next] ?? 0;
    if (size > AHEAD_FILE_MAX || loaded.has(`f:${next}`)) continue;
    if (bytes + size > AHEAD_BUDGET) break;
    const body = installer.rawSync(key, next, index);
    if (!body) continue;
    header.push(['f', next, body.length]);
    bodies.push(body);
    bytes += body.length;
  }
  if (header.length === 1) return null;
  return Buffer.concat([bundleHead(header), ...bodies]);
}

/**
 * Transforms pushed ahead, for an install never run (its prefetcher, prefetch.ts, knows what each
 * module requires): a runtime asks for a transformed file with `?ahead=1` over its file channel,
 * and gets it with the modules it requires, and theirs, breadth first, whose transforms are done (in
 * memory), and each one's nearest package.json, up to AHEAD_BUDGET; each is sent once per channel.
 * A cold start loaded its first modules one request each (astro dev ~600, waiting for the host), and
 * the predicted bundle comes seconds later. What the runtime reads from them it tells as read-ahead
 * files (?used=1); the rest is dropped.
 */
const pushed = new WeakMap<object, Set<string>>();

export function pushAhead(key: string, rel: string, first: Buffer, prefetcher: Prefetcher, channel: object): Buffer | null {
  if (first.length >= AHEAD_BUDGET) return null;
  let sent = pushed.get(channel);
  if (!sent) pushed.set(channel, (sent = new Set()));
  sent.add(`t:${rel}`);
  const header: [string, string, number][] = [['t', rel, first.length]];
  const bodies: Buffer[] = [first];
  let bytes = first.length;
  const add = (mode: string, path: string, body: Buffer) => {
    sent.add(`${mode}:${path}`);
    header.push([mode, path, body.length]);
    bodies.push(body);
    bytes += body.length;
  };
  const queue = [...(prefetcher.requires.get(rel) ?? [])];
  for (let i = 0; i < queue.length && header.length < AHEAD_FILES; i++) {
    const dep = queue[i];
    if (sent.has(`t:${dep}`)) continue;
    const body = installer.remembered(key, dep);
    if (!body) continue;
    if (bytes + body.length > AHEAD_BUDGET) break;
    add('t', dep, body);
    const pkg = nearestPackageJson(prefetcher.index, dep);
    const raw = pkg && !sent.has(`f:${pkg}`) ? installer.rawSync(key, pkg, prefetcher.index) : null;
    if (raw && bytes + raw.length <= AHEAD_BUDGET) add('f', pkg!, raw);
    queue.push(...(prefetcher.requires.get(dep) ?? []));
  }
  if (header.length === 1) return null;
  return Buffer.concat([bundleHead(header), ...bodies]);
}

/** The package.json Node reads for a module's "type": the nearest one up its directories. */
function nearestPackageJson(index: FileIndex, rel: string): string | null {
  for (let dir = rel.slice(0, rel.lastIndexOf('/')); dir.includes('/'); dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (`${dir}/package.json` in index) return `${dir}/package.json`;
  }
  return null;
}
