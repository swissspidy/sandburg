/**
 * Browser-side adapter contract. Bundled into the host page; must not import
 * Node modules.
 */
import type { AdapterErrorCode, FileTree, Framework, InstallReport, PackageJson, SerializedError } from '../types.ts';

export interface AdapterContext {
  signal: AbortSignal;
  packageJson: PackageJson | null;
  framework: Framework;
  log(stream: 'stdout' | 'stderr', line: string): void;
}

export interface RuntimeAdapter {
  readonly name: string;
  mount(files: FileTree, ctx: AdapterContext): Promise<void>;
  /** `hostData` is what the adapter's Node-side hostInstall() returned (if any). */
  install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport>;
  /** Starts the app and returns the URL to load in the app frame (same-origin, or an allowlisted preview origin). */
  start(ctx: AdapterContext): Promise<StartResult>;
  ready?(ctx: AdapterContext): Promise<void>;
  /** Rejects when the app's runtime fails after it started (the app frame would wait on it forever). */
  failed?(): Promise<never>;
  /** Requests the app's servers are still answering, and how long the runtime has been quiet. */
  activity?(): { inflight: number; idleMs: number } | null;
  dispose(): Promise<void>;
}

export interface StartResult {
  url: string;
  /** False when start() already loaded the app into the frame (default: true, the host navigates to url). */
  navigate?: boolean;
}

export class AdapterError extends Error {
  code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export type CreateAdapter = () => RuntimeAdapter;

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

/** What the host page (host.ts) exposes as `window.__sandburg`. */
export interface HostApi {
  mount(files: FileTree, pkg: PackageJson | null, fw: Framework): Promise<RpcResult<void>>;
  install(hostData?: unknown): Promise<RpcResult<InstallReport>>;
  start(): Promise<RpcResult<StartResult>>;
  /** Runtime readiness, then load the app URL into the frame and wait for its load event. */
  ready(url: string, navigate?: boolean): Promise<RpcResult<void>>;
  activity(): Promise<RpcResult<{ inflight: number; idleMs: number } | null>>;
  dispose(): Promise<RpcResult<void>>;
}

declare global {
  interface Window {
    __sandburg: HostApi;
  }
}
