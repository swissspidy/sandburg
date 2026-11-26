/**
 * Sandburg's browser runtime, for embedding in another page (`sandburg/browser-runtime`, ADR 0074):
 * the Node.js runtime, the project's dev server and the app run in the visitor's browser, with
 * packages installed from the npm registry and modules compiled in the page. No Sandburg host,
 * Node.js process or Playwright is involved; the embedder serves this directory as static files.
 *
 *   const options = { base: '/sandburg/', scope: '/play/' };
 *   if (await isolate(options)) {
 *     const host = await loadHost(options);
 *     const { url } = await startProject(host, files, options);
 *     guardAppFrame(frame, appPath(options));
 *   }
 *
 * The page needs an `<iframe id="app">`: the host loads the app into it.
 *
 * The app runs on the embedding page's origin: whatever the page can read, the app can too.
 * Its network is the browser's: no egress allowlist applies, unlike a Sandburg run.
 */
import type { HostApi, RpcResult } from '../host/types.ts';
import type { FileTree, InstallReport, PackageJson } from '../types.ts';
import { detectFramework } from '../framework.ts';
import { pageInstall } from '../adapters/node/plan.ts';
import { isolationFailure } from './isolation.js';

export { guardAppFrame } from './frame-guard.js';
export { isolationFailure, detectFramework, pageInstall };
export type { HostApi, RpcResult };
export type { FileTree, Framework, InstallReport, PackageJson } from '../types.ts';

export interface EmbedOptions {
  /** Where this directory is served (sw.js, host.js, runtime/). Default: where this module was loaded from. */
  base?: string | URL;
  /** The service worker's scope: a path that holds the embedding page. Default: the page's directory. */
  scope?: string;
  /** The path the app lives at, under the scope. Default: `<scope>app`. */
  app?: string;
  /**
   * Path prefixes of the embedder's own files (its scripts, styles) under the scope, which the
   * service worker leaves to the network. This directory's files always are. Other paths outside the app
   * are taken to be the app's own absolute paths (/_next/…, /src/main.tsx).
   */
  pass?: string[];
}

interface Resolved {
  base: URL;
  scope: string;
  app: string;
  sw: { url: string; scope: string };
}

function resolveOptions(options: EmbedOptions): Resolved {
  const base = new URL(options.base ?? './', options.base ? location.href : import.meta.url);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  // A directory: the host's base (<scope>__sandburg) and the app's default path are under it.
  const scope = new URL(options.scope ?? './', location.href).pathname.replace(/\/?$/, '/');
  const app = (options.app ?? scope + 'app').replace(/\/+$/, '');
  const query = new URLSearchParams({ app });
  if (options.pass?.length) query.set('pass', options.pass.join(','));
  return { base, scope, app, sw: { url: `${new URL('sw.js', base).pathname}?${query}`, scope } };
}

/** The path the app lives at (`EmbedOptions.app`): the app frame loads it, and guardAppFrame keeps the frame under it. */
export function appPath(options: EmbedOptions = {}): string {
  return resolveOptions(options).app;
}

const RELOADED = 'sandburg-browser-runtime-reloaded';

/**
 * Makes the page cross-origin isolated, which the runtime's shared memory needs: registers the
 * runtime's service worker, which gives the page the headers, and reloads the page once. Resolves
 * true when the page is isolated, false when it is reloading (do nothing more). Rejects, with
 * isolationFailure()'s explanation, when the reload did not help. A page served with the headers
 * (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy) is isolated at once, but
 * still needs the service worker: loadHost registers it.
 */
export async function isolate(options: EmbedOptions = {}): Promise<boolean> {
  if (!('serviceWorker' in navigator)) throw new Error('This page needs service workers, which this browser (or this private window) does not offer.');
  const { sw } = resolveOptions(options);
  const session = (() => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  })();
  if (self.crossOriginIsolated) {
    session?.removeItem(RELOADED);
    return true;
  }
  await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
  await navigator.serviceWorker.ready;
  if (session?.getItem(RELOADED)) {
    session.removeItem(RELOADED);
    throw new Error(isolationFailure());
  }
  session?.setItem(RELOADED, '1');
  location.reload();
  return false;
}

/** Loads the runtime's host (host.js) into the page: `window.__sandburg`, the API a Sandburg run drives. */
export async function loadHost(options: EmbedOptions = {}): Promise<HostApi> {
  const { base, scope, sw } = resolveOptions(options);
  Object.assign(globalThis, { __sandburgBase: scope + '__sandburg', __sandburgServiceWorker: sw });
  await import(/* @vite-ignore */ new URL('host.js', base).href);
  return (globalThis as unknown as { __sandburg: HostApi }).__sandburg;
}

async function unwrap<T>(result: Promise<RpcResult<T>>): Promise<T> {
  const r = await result;
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.error.message), { name: r.error.name });
}

export interface StartedProject {
  /** The app's URL as it sees itself (/, or the path its dev server opens). */
  url: string;
  install: InstallReport;
}

/**
 * Runs a project as a Sandburg run does: mounts its files, installs its packages (from the npm
 * registry, in the page), starts its dev server or `npm start`, and loads the app into the host's app
 * frame once it answers. Ends a run the host had first. Rejects with the phase's error.
 */
export async function startProject(host: HostApi, files: FileTree, options: EmbedOptions = {}): Promise<StartedProject> {
  const { app } = resolveOptions(options);
  const packageJson: PackageJson | null = typeof files['package.json'] === 'string' ? (JSON.parse(files['package.json']) as PackageJson) : null;
  const framework = detectFramework(files, packageJson);
  await host.dispose();
  await unwrap(host.mount(files, packageJson, framework));
  const install = await unwrap(host.install(pageInstall({ name: 'app', path: 'embedded', files, packageJson, framework, snapshotId: '' })));
  const { url } = await unwrap(host.start());
  await unwrap(host.ready(app + url));
  return { url, install };
}
