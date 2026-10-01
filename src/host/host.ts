/**
 * Host page entry. Bundled per adapter; `sandburg:adapter` is aliased to the
 * adapter's browser module. The orchestrator drives the lifecycle through
 * `window.__sandburg`; every call resolves to an `RpcResult` and never throws,
 * so errors keep their code across the page.evaluate boundary.
 */
import { createAdapter } from 'sandburg:adapter';
import type { AdapterContext, RuntimeAdapter } from './types.ts';
import type { FileTree, Framework, PackageJson, SerializedError } from '../types.ts';

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

let adapter: RuntimeAdapter | null = null;
let packageJson: PackageJson | null = null;
let framework: Framework = 'unknown';
const controller = new AbortController();

function ctx(): AdapterContext {
  return {
    signal: controller.signal,
    packageJson,
    framework,
    log(stream, line) {
      (stream === 'stderr' ? console.warn : console.log)(`[runtime:${stream}] ${line}`);
    },
  };
}

function serialize(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, stack: err.stack, code: typeof code === 'string' ? code : undefined };
  }
  return { name: 'Error', message: String(err) };
}

async function call<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: serialize(err) };
  }
}

function current(): RuntimeAdapter {
  if (!adapter) throw new Error('mount() has not run');
  return adapter;
}

function appFrame(): HTMLIFrameElement {
  return document.getElementById('app') as HTMLIFrameElement;
}

const api = {
  mount: (files: FileTree, pkg: PackageJson | null, fw: Framework) =>
    call(async () => {
      packageJson = pkg;
      framework = fw;
      adapter = createAdapter();
      await adapter.mount(files, ctx());
    }),
  install: (hostData?: unknown) => call(() => current().install(ctx(), hostData)),
  start: () => call(() => current().start(ctx())),
  /** Runtime readiness, then load the app URL into the frame and wait for its load event. */
  ready: (url: string, navigate = true) =>
    call(async () => {
      // A runtime that fails while the app loads (its dev server crashed) ends the wait.
      const failed = current().failed?.();
      const unless = <T>(p: Promise<T>) => (failed ? Promise.race([p, failed]) : p);
      await unless(current().ready?.(ctx()) ?? Promise.resolve());
      if (!navigate) return;
      const frame = appFrame();
      await unless(
        new Promise<void>((resolve) => {
          frame.addEventListener('load', () => resolve(), { once: true });
          frame.src = url;
        }),
      );
    }),
  activity: () => call(async () => adapter?.activity?.() ?? null),
  dispose: () =>
    call(async () => {
      controller.abort();
      await adapter?.dispose();
      adapter = null;
    }),
};

export type HostApi = typeof api;

declare global {
  interface Window {
    __sandburg: HostApi;
  }
}

window.__sandburg = api;
document.documentElement.dataset.sandburg = 'ready';
