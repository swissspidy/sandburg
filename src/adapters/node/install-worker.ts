/**
 * The install in the browser (browser-npm/install.ts), off the page's main thread: resolving the
 * tree, gunzipping and untarring each tarball, the source patches and copying node_modules into
 * shared memory (packFiles) take hundreds of milliseconds to seconds of CPU on a large tree, which
 * the page would spend janked. One install per worker: the page starts one, sends the parts, and
 * gets log lines and then node_modules as shared memory (no copy) and its index.
 */
import { installInBrowser, packFiles, type BrowserInstallPart } from './browser-npm/install.ts';
import { Registry } from './browser-npm/registry.ts';
import { UnsupportedSpecError } from './browser-npm/resolve.ts';

export type InstallWorkerRequest = { parts: BrowserInstallPart[] };

export type InstallWorkerMessage =
  | { type: 'log'; line: string }
  | {
      type: 'done';
      sab: SharedArrayBuffer;
      index: Record<string, [number, number]>;
      resolved: Record<string, string>;
      lockfile: boolean;
      /** The shell's index of package binaries (node_modules/.sandburg-bins.json), name → file. */
      bins: Record<string, string>;
    }
  /** `unsupported`: a dependency spec the install does not support (UnsupportedSpecError). */
  | { type: 'error'; message: string; unsupported: boolean };

interface Port {
  onmessage: ((e: MessageEvent<InstallWorkerRequest>) => void) | null;
  postMessage(message: InstallWorkerMessage): void;
}
const scope = self as unknown as Port;

// oxlint-disable-next-line typescript/no-misused-promises -- its body catches what it throws
scope.onmessage = async (e) => {
  try {
    const result = await installInBrowser(e.data.parts, new Registry(), (line) => scope.postMessage({ type: 'log', line }));
    const bins = result.files.get('node_modules/.sandburg-bins.json');
    const { sab, index } = packFiles(result.files);
    scope.postMessage({ type: 'done', sab, index, resolved: result.resolved, lockfile: result.lockfile, bins: bins ? (JSON.parse(new TextDecoder().decode(bins)) as Record<string, string>) : {} });
  } catch (err) {
    scope.postMessage({ type: 'error', message: String((err as Error)?.message ?? err), unsupported: err instanceof UnsupportedSpecError });
  }
};
