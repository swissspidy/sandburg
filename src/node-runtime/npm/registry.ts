/**
 * The npm registry, read the way npm reads it: abbreviated package documents ("corgi") for
 * resolution, tarballs for the files. Works in a browser page (the registry answers cross-origin
 * requests) and in Node (tests). Tarballs are checked against their published integrity.
 */
import { untar, type TarFile } from './tar.ts';

export interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  dist: { tarball: string; integrity?: string; shasum?: string };
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, Manifest>;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export class Registry {
  private packuments = new Map<string, Promise<Packument | null>>();
  private fetchFn: Fetch;
  private base: string;

  constructor(fetchFn: Fetch = (url, init) => fetch(url, init), base = 'https://registry.npmjs.org') {
    this.fetchFn = fetchFn;
    this.base = base;
  }

  /** A package's versions, or null if the registry has no such package. */
  packument(name: string): Promise<Packument | null> {
    let p = this.packuments.get(name);
    if (!p) {
      p = (async () => {
        const res = await transport(name, () => this.fetchFn(`${this.base}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } }));
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`npm registry: ${name}: HTTP ${res.status}`);
        return transport(name, () => res.json() as Promise<Packument>);
      })();
      p.catch(() => this.packuments.delete(name));
      this.packuments.set(name, p);
    }
    return p;
  }

  /** A version's files (the tarball's, without its top directory), after checking its integrity. */
  async files(manifest: { name: string; version: string; dist: Manifest['dist'] }): Promise<TarFile[]> {
    const what = `${manifest.name}@${manifest.version}`;
    const res = await transport(what, () => this.fetchFn(manifest.dist.tarball));
    if (!res.ok) throw new Error(`npm registry: ${what}: HTTP ${res.status} - GET ${manifest.dist.tarball}`);
    const gz = new Uint8Array(await transport(what, () => res.arrayBuffer()));
    await verify(gz, manifest.dist, what);
    return untar(await transport(what, () => gunzip(gz)));
  }
}

/**
 * A failure to reach the registry or to read what it sent (network, HTTP, a truncated download): the
 * "npm registry:" prefix marks it as the environment's failure, not the app's (classify.ts).
 */
async function transport<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`npm registry: ${what}: ${(e as Error).message}`, { cause: e });
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Subresource-integrity check (sha512, as npm publishes), or the older sha1 shasum. */
async function verify(bytes: Uint8Array, dist: Manifest['dist'], what: string): Promise<void> {
  const data = bytes as Uint8Array<ArrayBuffer>;
  const sri = dist.integrity?.split(/\s+/).find((s) => s.startsWith('sha512-'));
  if (sri) {
    if (`sha512-${base64(await crypto.subtle.digest('SHA-512', data))}` !== sri) throw new Error(`npm registry: ${what}: integrity check failed`);
  } else if (dist.shasum) {
    if (hex(await crypto.subtle.digest('SHA-1', data)) !== dist.shasum) throw new Error(`npm registry: ${what}: shasum check failed`);
  }
}
