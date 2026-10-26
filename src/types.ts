/**
 * Shared types: project input, adapter contracts and the v1 result schema.
 * See docs/adr/0001-runtime-adapters-serving-results.md.
 */

/** File path (POSIX, relative to project root, no leading slash) → contents. */
export type FileTree = Record<string, FileContent>;
/** A file's text, or its bytes in base64 when it is not UTF-8 text. */
export type FileContent = string | { base64: string };

/** The framework a project was detected as (src/framework.ts). */
export type Framework = 'vite' | 'next' | 'angular' | 'astro' | 'sveltekit' | 'nuxt' | 'solid-start' | 'react-router' | 'static' | 'unknown';

/** A project to run: its files and what was detected from them. */
export interface Project {
  name: string;
  /** Where the project came from (directory, zip or JSON path). */
  path: string;
  files: FileTree;
  packageJson: PackageJson | null;
  framework: Framework;
  /** Content-addressed id of the file tree (see src/store.ts). */
  snapshotId: string;
}

/** The fields of a project's package.json that Sandburg reads; the rest as they are. */
export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/** Whether a runtime can run a project (the probe phase). */
export type ProbeVerdict =
  | { verdict: 'supported' }
  | { verdict: 'unknown'; reason: string }
  | { verdict: 'unsupported'; reason: string };

/** Node-side half of a runtime adapter. */
export interface AdapterDescriptor {
  name: string;
  version: string;
  /** Absolute path of the browser module exporting `createAdapter()`. */
  browserEntry: string;
  /** Extra files the host origin serves: URL path → absolute file path. */
  assets: Record<string, string>;
  /** Upstream origins the runtime itself needs (e.g. CDNs). */
  egress: string[];
  /** Host sends COOP/COEP when true. */
  /**
   * Serve the sandbox cross-origin isolated (SharedArrayBuffer, WebAssembly threads). 'credentialless'
   * uses COEP: credentialless, so cross-origin no-cors resources (fonts, images) still load.
   */
  crossOriginIsolation: boolean | 'credentialless';
  /** Default phase deadlines for this runtime (user options still win). */
  timeouts?: Partial<Record<PhaseName | 'check' | 'expect', number>>;
  /** Compile-time constants for the browser bundle (esbuild `define`): identifier → JSON value. */
  bundleDefines?: Record<string, string>;
  /** Module path aliases for bundling the browser entry. */
  bundleAliases?: Record<string, string>;
  probe(project: Project): ProbeVerdict;
  /**
   * Host-side part of the install phase (e.g. npm install --ignore-scripts for the
   * node runtime). Its result is passed to the browser adapter's install().
   * Must not execute project code.
   */
  hostInstall?(project: Project, log: (line: string) => void, options?: HostInstallOptions): Promise<unknown>;
  /** Extra routes under /__sandburg/ on the sandbox origin (worker bundles, file serving, compile). */
  serve?(request: HostRequest): Promise<HostResponse | null>;
  /** Small projects on common stacks, run before a batch when not warm (Session.prewarm). */
  warmups?(): Project[];
  /** Whether a project's install is already there. */
  isWarm?(project: Project): Promise<boolean>;
  /** Gets the host ready for a first install while the session opens (Session.open). */
  prepare?(): void;
}

/** What the session tells an adapter's host-side install. */
export interface HostInstallOptions {
  /**
   * This run is a seed, started by the session to fill caches that other projects' runs share
   * (the node adapter's Next.js cache). Only the session sets it: a project can never.
   */
  seed?: boolean;
  /** Runs a seed project (Sandburg's own, with the given checks) in this session and waits for it. */
  runSeed?(project: Project, checks: unknown): Promise<void>;
  /** Where dependencies are installed: by npm on the host (default), or in the browser (opt-in). */
  installIn?: 'host' | 'browser';
  /**
   * The sandbox (HostServer id) the run's page is in, once its tab is known. Write capabilities the
   * install issues to the run are bound to it (HostRequest.sandbox).
   */
  sandbox?: Promise<string>;
}

/** A request to an adapter's routes under /__sandburg/ on a sandbox's origin (AdapterDescriptor.serve). */
export interface HostRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The sandbox the request came from (by its origin), set by the host server. */
  sandbox?: string;
  /** Request headers, lowercase names. */
  headers?: Record<string, string | undefined>;
  /**
   * The request's body, at most `max` bytes (the host server's default, BODY_MAX, without one): a
   * larger one is refused with a 413 as soon as its Content-Length or the bytes received exceed it.
   */
  body(max?: number): Promise<Buffer>;
  /** The file channel (one per runtime and its threads) the request came on; absent over HTTP. */
  channel?: object;
}

/** An adapter route's answer. */
export interface HostResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

/** Why an adapter failed: the project is not supported, the app failed, or the adapter itself did. */
export type AdapterErrorCode = 'UNSUPPORTED' | 'APP' | 'INTERNAL';

/** How the install phase resolved the project's dependencies. */
export interface InstallReport {
  resolution: 'lockfile' | 'range' | 'none';
  lockfileHonored: boolean;
  /** Package name → resolved version or range. */
  dependencies: Record<string, string>;
  buildMs?: number | null;
  /** Modules the adapter replaced with Sandburg stand-ins (a fidelity risk). */
  shims?: string[];
}

// ---------------------------------------------------------------------------
// Result schema v1
// ---------------------------------------------------------------------------

/** A run's phases, in order. */
export type PhaseName = 'probe' | 'load' | 'mount' | 'install' | 'start' | 'ready' | 'checks' | 'dispose';
/** How a phase ended; skipped when an earlier one failed. */
export type PhaseStatus = 'ok' | 'failed' | 'timeout' | 'skipped';

/** One phase of a run: how it ended, how long it took, and its error if it failed or timed out. */
export interface PhaseRecord {
  name: PhaseName;
  status: PhaseStatus;
  durationMs: number;
  error?: SerializedError;
}

/** An error as a run records it: a phase's (PhaseRecord.error) or one a runtime reported. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

/** What a check looks at: the app's behaviour (functional, the checks file's), or what the run collected. */
export type CheckKind = 'functional' | 'document' | 'console' | 'network' | 'axe' | 'a11y-snapshot' | 'screenshot';
/** How a check ended: error when the check itself broke, skipped when it did not run. */
export type CheckStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** One check of a run. */
export interface CheckResult {
  id: string;
  kind: CheckKind;
  name: string;
  status: CheckStatus;
  /** Blocking checks decide pass/fail; the rest are informational. */
  blocking: boolean;
  durationMs: number;
  message?: string;
  details?: unknown;
}

/** Whose fault a failed run is: the runtime's, the app's, a deadline's, the infrastructure's, or not known. */
export type FailureClass = 'runtime-unsupported' | 'app-bug' | 'timeout' | 'infra' | 'unknown';

/** Why a run failed (RunResult.failure), as classify() decided. */
export interface Failure {
  class: FailureClass;
  phase: PhaseName;
  /** Identifier of the classification rule that fired (see src/classify.ts). */
  rule: string;
  message: string;
  evidence: string[];
}

/** A console message from the app's page or Sandburg's host page. */
export interface ConsoleEntry {
  source: 'app' | 'host';
  type: string;
  text: string;
  url?: string;
}

/** An uncaught exception in the app's page or the host page. */
export interface PageError {
  source: 'app' | 'host';
  message: string;
  stack?: string;
}

/** A request that failed or that the egress gateway blocked, and why. */
export interface NetworkEntry {
  url: string;
  method: string;
  reason: string;
}

/** A run's result (result.json, schema version 1). */
export interface RunResult {
  schemaVersion: 1;
  runId: string;
  status: 'passed' | 'failed' | 'error';
  project: {
    name: string;
    path: string;
    framework: Framework;
    snapshotId: string;
    fileCount: number;
  };
  runtime: { name: string; version: string };
  /** Run ids of earlier attempts discarded because they failed as infra (see RunOptions.infraRetries). */
  previousAttempts?: string[];
  environment: {
    sandburgVersion: string;
    browser: string;
    /**
     * The browser ran inside Chromium's OS sandbox (false: turned off with SessionOptions.browserSandbox
     * or its CLI flag or env var). Optional in result-schema.json: results from before ADR 0061 do not
     * have it, and ran without the sandbox.
     */
    browserSandbox: boolean;
    platform: string;
    offline: boolean;
  };
  startedAt: string;
  finishedAt: string;
  timings: {
    probeMs: number | null;
    loadMs: number | null;
    mountMs: number | null;
    installMs: number | null;
    buildMs: number | null;
    startMs: number | null;
    readyMs: number | null;
    checksMs: number | null;
    totalMs: number;
  };
  phases: PhaseRecord[];
  install: InstallReport | null;
  checks: CheckResult[];
  failure: Failure | null;
  console: ConsoleEntry[];
  pageErrors: PageError[];
  network: {
    requests: number;
    cacheHits: number;
    cacheMisses: number;
    /** Connections tunneled by the egress proxy (policed by origin, not cached). */
    tunneled?: number;
    failed: NetworkEntry[];
    blocked: NetworkEntry[];
  };
  /**
   * The most memory the run's renderer (its page, workers and service worker) was seen to hold:
   * resident anonymous and shared memory, read about once a second. In-browser runs on Linux only.
   */
  memory?: { rendererPeakBytes: number };
  artifacts: {
    screenshot?: string;
    a11ySnapshot?: string;
    /** Install and server output of an out-of-browser runtime. */
    runtimeLog?: string;
  };
}
