/**
 * Shared types: project input, adapter contracts and the v1 result schema.
 * See docs/adr/0001-runtime-adapters-serving-results.md.
 */

/** File path (POSIX, relative to project root, no leading slash) → contents. */
export type FileTree = Record<string, FileContent>;
export type FileContent = string | { base64: string };

export type Framework = 'vite' | 'next' | 'angular' | 'astro' | 'sveltekit' | 'nuxt' | 'solid-start' | 'react-router' | 'static' | 'unknown';

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

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

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
}

export interface HostInstallOptions {
  /**
   * This run is a seed, started by the session to fill caches that other projects' runs share
   * (the node adapter's Next.js cache). Only the session sets it: a project can never.
   */
  seed?: boolean;
  /** Runs a seed project (Sandburg's own, with the given checks) in this session and waits for it. */
  runSeed?(project: Project, checks: unknown): Promise<void>;
}

export interface HostRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body(): Promise<Buffer>;
}

export interface HostResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export type AdapterErrorCode = 'UNSUPPORTED' | 'APP' | 'INTERNAL';

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

export type PhaseName = 'probe' | 'load' | 'mount' | 'install' | 'start' | 'ready' | 'checks' | 'dispose';
export type PhaseStatus = 'ok' | 'failed' | 'timeout' | 'skipped';

export interface PhaseRecord {
  name: PhaseName;
  status: PhaseStatus;
  durationMs: number;
  error?: SerializedError;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export type CheckKind = 'functional' | 'document' | 'console' | 'network' | 'axe' | 'a11y-snapshot' | 'screenshot';
export type CheckStatus = 'passed' | 'failed' | 'error' | 'skipped';

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

export type FailureClass = 'runtime-unsupported' | 'app-bug' | 'timeout' | 'infra' | 'unknown';

export interface Failure {
  class: FailureClass;
  phase: PhaseName;
  /** Identifier of the classification rule that fired (see src/classify.ts). */
  rule: string;
  message: string;
  evidence: string[];
}

export interface ConsoleEntry {
  source: 'app' | 'host';
  type: string;
  text: string;
  url?: string;
}

export interface PageError {
  source: 'app' | 'host';
  message: string;
  stack?: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  reason: string;
}

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
  artifacts: {
    screenshot?: string;
    a11ySnapshot?: string;
    /** Install and server output of an out-of-browser runtime. */
    runtimeLog?: string;
  };
}
