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
  activity?(): Activity | null;
  dispose(): Promise<void>;
}

/** What the app's servers are doing: their requests from the page, and when the runtime last spoke. */
export interface Activity {
  /** Requests still being answered. */
  inflight: number;
  /** Since the runtime last sent or heard anything (a request, a response, a log line). */
  idleMs: number;
  /** Since the page last sent a request. */
  sinceRequestMs?: number;
  /** Age of the youngest request still in flight (null when none is). */
  newestInflightMs?: number | null;
}

interface StartResult {
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

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

/** What the host page (host.ts) exposes as `window.__sandburg`. */
export interface HostApi {
  mount(files: FileTree, pkg: PackageJson | null, fw: Framework): Promise<RpcResult<void>>;
  install(hostData?: unknown): Promise<RpcResult<InstallReport>>;
  start(): Promise<RpcResult<StartResult>>;
  /** Runtime readiness, then load the app URL into the frame and wait for its load event. */
  ready(url: string, navigate?: boolean): Promise<RpcResult<void>>;
  /**
   * Whether the app frame shows a rendered app (its document, read from the host page, as
   * waitForRender in session.ts reads it): `selector` matches, else #root/#app/#__next has content,
   * else the body has text. False for the browser's error page and a dev server's loading page.
   */
  rendered(selector: string | null): Promise<RpcResult<boolean>>;
  activity(): Promise<RpcResult<Activity | null>>;
  /**
   * Waits until the app has settled (see Activity): no request sent for `quietMs`, and none in
   * flight that was sent within `longMs` (a long-lived stream or long poll does not count), or
   * `maxMs` passed. Whether it settled; null without a runtime that reports its activity.
   */
  settled(quietMs: number, longMs: number, maxMs: number): Promise<RpcResult<boolean | null>>;
  dispose(): Promise<RpcResult<void>>;
}

declare global {
  interface Window {
    __sandburg: HostApi;
  }
}
