/**
 * What a run records as it goes (RunState): its phases under their deadlines, the page's console,
 * errors, requests and documents, and the result it makes of them. The errors a run reports are
 * SerializedErrors in its phases (a PhaseTimeout, an RpcError from the host page, or what a phase
 * threw), and the Failure that classify() makes of them.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform } from 'node:os';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { classify } from '../classify.ts';
import type { SourceFinding } from '../source-check.ts';
import type { ConsoleEntry, InstallReport, PageError, PhaseName, PhaseRecord, ProbeVerdict, Project, RunResult, SerializedError } from '../types.ts';
import type { RpcResult } from '../host/types.ts';
import type { ChecksOutput } from './checks.ts';
import { record, type EgressStats } from './egress.ts';
import { SANDBURG_VERSION } from '../version.ts';
import { RendererMemory } from './renderer-memory.ts';
import { traceConsole, tracingTransfers } from '../transfer-trace.ts';
import { CONSOLE_MAX, capResult, capText } from './limits.ts';

class PhaseTimeout extends Error {
  constructor(phase: PhaseName, ms: number) {
    super(`${phase} did not finish within ${ms} ms`);
    this.name = 'PhaseTimeout';
  }
}

class RpcError extends Error {
  code?: string;
  constructor(err: SerializedError) {
    super(err.message);
    this.name = err.name;
    this.code = err.code;
    this.stack = err.stack;
  }
}

/**
 * Requests that failed in the browser for reasons other than the gateway's own
 * blocking (DNS, TLS, resets, a service worker's fetch failing).
 */
export function recordRequestFailures(context: BrowserContext, run: RunState): void {
  context.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? 'failed';
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(reason) || !run.network || run.network.failed.length >= 100) return;
    record(run.network.failed, { url: req.url(), method: req.method(), reason: `browser: ${reason}` });
  });
}

/** The status of each document the app's frames load (a server-rendered error page is a 5xx), and when it came. */
export function recordDocuments(context: BrowserContext, run: RunState): void {
  context.on('response', (res) => {
    const req = res.request();
    if (!req.isNavigationRequest() || run.documents.length >= 200) return;
    run.documents.push({ frame: res.frame(), url: res.url(), status: res.status(), csp: 'content-security-policy' in res.headers(), at: Date.now() });
  });
}

export class RunState {
  phases: PhaseRecord[] = [];
  probe: ProbeVerdict | null = null;
  install: InstallReport | null = null;
  checksOutput: ChecksOutput | null = null;
  network: EgressStats | null = null;
  console: ConsoleEntry[] = [];
  pageErrors: PageError[] = [];
  /** `at`: when its response came (Date.now()). */
  documents: { frame: Frame; url: string; status: number; csp?: boolean; at?: number }[] = [];
  infraError: { phase: PhaseName; message: string } | null = null;
  /** The run's project or checks file did not load (failSetup). */
  setupError: { rule: 'project-load' | 'checks-load'; class: 'app-bug' | 'unknown'; message: string } | null = null;
  /** Where the console stood when the ready phase began (what the dev server logged while it served the app's page follows). */
  private readyConsoleFrom: number | null = null;
  /** What checking the project's sources found that bears on the app, when the ready phase had it checked (watchSources). */
  sourceFindings: SourceFinding[] | null = null;
  /** The path of the app's page, once its dev server has started (classification evidence; appStarted). */
  appPath: string | null = null;

  /** The app's dev server started: `url` is where the app's page loads, a path ('/', as the node runtime answers) or a whole URL. */
  appStarted(url: string): void {
    this.appPath = URL.canParse(url, 'http://app.invalid') ? new URL(url, 'http://app.invalid').pathname : null;
  }
  /** Output of an out-of-browser runtime (install and server logs), used as classification evidence. */
  runtimeLogs: string[] = [];
  /** The run's renderer, once it has a tab (RunResult.memory). */
  memory: RendererMemory | null = null;
  private startedAt = new Date();
  private t0 = performance.now();
  private runId: string;
  private project: Project;
  private runtime: { name: string; version: string };
  private offline: boolean;
  private browserVersion: string;
  private browserSandbox: boolean;

  constructor(runId: string, project: Project, runtime: { name: string; version: string }, offline: boolean, browserVersion: string, browserSandbox: boolean) {
    this.runId = runId;
    this.project = project;
    this.runtime = { name: runtime.name, version: runtime.version };
    this.offline = offline;
    this.browserVersion = browserVersion;
    this.browserSandbox = browserSandbox;
  }

  /** Runs one lifecycle phase under a deadline and records its outcome. Rethrows on failure. */
  onPhase?: (phase: PhaseName) => void;

  /** `fn`'s signal aborts at the deadline (with the PhaseTimeout), for work that can stop. */
  async phase<T>(name: PhaseName, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.onPhase?.(name);
    if (name === 'ready') this.readyConsoleFrom = this.console.length;
    const start = performance.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new PhaseTimeout(name, timeoutMs);
          controller.abort(timeout);
          reject(timeout);
        }, timeoutMs);
      });
      const value = await Promise.race([fn(controller.signal), deadline]);
      this.phases.push({ name, status: 'ok', durationMs: ms(start) });
      return value;
    } catch (err) {
      const error = serialize(err);
      const timedOut = err instanceof PhaseTimeout;
      this.phases.push({ name, status: timedOut ? 'timeout' : 'failed', durationMs: ms(start), error });
      if (!timedOut && isInfra(err)) this.infraError = { phase: name, message: error.message };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The run cannot start: its project or checks file did not load. Recorded as its probe phase's
   * failure; `appBug`: the project is there, but broken (not a JSON tree, a zip, …).
   */
  failSetup(rule: 'project-load' | 'checks-load', err: unknown, appBug = false): void {
    const error = serialize(err);
    this.phases.push({ name: 'probe', status: 'failed', durationMs: 0, error });
    this.setupError = { rule, class: appBug ? 'app-bug' : 'unknown', message: error.message };
  }

  skipRemaining(): void {
    const order: PhaseName[] = ['probe', 'load', 'mount', 'install', 'start', 'ready', 'checks', 'dispose'];
    for (const name of order) {
      if (!this.phases.some((p) => p.name === name)) this.phases.push({ name, status: 'skipped', durationMs: 0 });
    }
    this.phases.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  capture(page: Page, origin: string): void {
    // An install in the browser fetches from the npm registry, and looks up names that may not exist
    // (napi-rs' wasm32-wasi packages): the browser logs those 404s, and they are not the app's.
    const sourceOf = (url: string): 'app' | 'host' =>
      url.startsWith(`${origin}/__sandburg/`) || url.startsWith(`${origin}/__sw__`) || url.includes('esbuild-wasm') || url.startsWith('https://registry.npmjs.org/') ? 'host' : 'app';
    page.on('console', (msg) => {
      if (tracingTransfers && msg.type() === 'debug' && traceConsole(msg.text())) return;
      if (this.console.length >= 500) return;
      const url = msg.location().url;
      this.console.push({ source: sourceOf(url), type: msg.type(), text: capText(msg.text(), CONSOLE_MAX), url: url ? capText(url, CONSOLE_MAX) : undefined });
    });
    page.on('pageerror', (err) => {
      if (this.pageErrors.length >= 100) return;
      const firstFrame = /(https?:\/\/[^\s)]+)/.exec(err.stack ?? '')?.[1] ?? '';
      this.pageErrors.push({ source: sourceOf(firstFrame), message: capText(err.message), stack: err.stack === undefined ? undefined : capText(err.stack) });
    });
    page.on('crash', () => {
      this.infraError = { phase: this.phases.at(-1)?.name ?? 'load', message: 'browser tab crashed' };
    });
  }

  async finish(outDir: string): Promise<RunResult> {
    const offlineMiss = this.network?.failed.find((f) => f.reason.startsWith('offline mode:'));
    if (offlineMiss && !this.infraError) this.infraError = { phase: 'ready', message: offlineMiss.reason };
    const byName = (n: PhaseName) => this.phases.find((p) => p.name === n && p.status !== 'skipped')?.durationMs ?? null;
    const checks = this.checksOutput?.checks ?? [];
    // Console errors from the app are evidence too (e.g. module resolution failures).
    const appConsoleErrors: PageError[] = this.console
      .filter((c) => c.source === 'app' && c.type === 'error')
      .map((c) => ({ source: 'app', message: c.text }));
    const failure = classify({
      probe: this.probe,
      phases: this.phases,
      checks,
      pageErrors: [...this.pageErrors, ...appConsoleErrors],
      runtimeErrors: [
        ...this.console.filter((c) => c.source === 'host' && c.type === 'error').map((c) => c.text),
        ...this.runtimeLogs,
      ],
      runtimeOutput: this.console.filter(isRuntimeOutput).map((c) => c.text),
      readyOutputFrom: this.readyConsoleFrom === null ? undefined : this.console.slice(0, this.readyConsoleFrom).filter(isRuntimeOutput).length,
      appPath: this.appPath,
      sourceFindings: this.sourceFindings,
      infraError: this.infraError,
      setupError: this.setupError,
      declaredDependencies: Object.keys({ ...this.project.packageJson?.dependencies, ...this.project.packageJson?.devDependencies }),
    });
    const reachedChecks = this.phases.some((p) => p.name === 'checks' && p.status === 'ok');
    const blockingFailed = checks.some((c) => c.blocking && c.status !== 'passed' && c.status !== 'skipped');
    const result: RunResult = {
      schemaVersion: 1,
      runId: this.runId,
      status: !reachedChecks ? 'error' : blockingFailed ? 'failed' : 'passed',
      project: {
        name: this.project.name,
        path: this.project.path,
        framework: this.project.framework,
        snapshotId: this.project.snapshotId,
        fileCount: Object.keys(this.project.files).length,
      },
      runtime: this.runtime,
      environment: {
        sandburgVersion: SANDBURG_VERSION,
        browser: `chromium ${this.browserVersion}`,
        browserSandbox: this.browserSandbox,
        platform: `${platform()}-${arch()}`,
        offline: this.offline,
      },
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      timings: {
        probeMs: byName('probe'),
        loadMs: byName('load'),
        mountMs: byName('mount'),
        installMs: byName('install'),
        buildMs: this.install?.buildMs ?? null,
        startMs: byName('start'),
        readyMs: byName('ready'),
        checksMs: byName('checks'),
        totalMs: ms(this.t0),
      },
      phases: this.phases,
      install: this.install,
      checks,
      failure,
      console: this.console,
      pageErrors: this.pageErrors,
      network: this.network ?? { requests: 0, cacheHits: 0, cacheMisses: 0, failed: [], blocked: [] },
      artifacts: this.checksOutput?.artifacts ?? {},
    };
    this.memory?.used(); // a last look, for the peak
    if (this.memory?.peak) result.memory = { rendererPeakBytes: this.memory.peak };
    if (this.runtimeLogs.length) {
      result.artifacts.runtimeLog = join(outDir, 'runtime.log');
      await writeFile(result.artifacts.runtimeLog, this.runtimeLogs.join('\n') + '\n');
    }
    capResult(result);
    await writeFile(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  }
}

export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new RpcError(result.error);
  return result.value;
}

function isInfra(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target (page|crashed|closed)|Browser has been closed|browser has disconnected|offline mode:|Cannot connect to the Docker daemon/i.test(msg);
}

function serialize(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: capText(err.name, 200), message: capText(err.message), code: typeof code === 'string' ? capText(code, 200) : undefined, stack: err.stack === undefined ? undefined : capText(err.stack) };
  }
  return { name: 'Error', message: capText(String(err)) };
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}

/** A line the app's runtime printed (stdout or stderr), as the host page logs it. */
const isRuntimeOutput = (c: ConsoleEntry) => c.source === 'host' && /^\[runtime:std(?:out|err)\]/.test(c.text);
