/**
 * A session owns the browser, the host server and the egress gateway. Runs in
 * a session share them; each run gets its own browser context, tab and origin.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Frame, type LaunchOptions, type Page } from 'playwright-core';
import { getAdapter } from '../adapters.ts';
import { classify } from '../classify.ts';
import { loadProject } from '../project.ts';
import type {
  AdapterDescriptor,
  ConsoleEntry,
  InstallReport,
  PageError,
  PhaseName,
  PhaseRecord,
  ProbeVerdict,
  Project,
  RunResult,
  SerializedError,
} from '../types.ts';
import type { HostApi, RpcResult } from '../host/host.ts';
import { loadChecks, runChecks, type Checks, type ChecksOutput } from './checks.ts';
import { EgressGateway, type EgressStats } from './egress.ts';
import { HostServer, SANDBOX_DOMAIN } from './host-server.ts';
import { SANDBURG_VERSION } from '../version.ts';
import { SnapshotStore } from '../store.ts';

export interface SessionOptions {
  /** Directory for the HTTP cache. Default: .sandburg/cache */
  cacheDir?: string;
  /** Directory of the snapshot store. Default: .sandburg/store */
  storeDir?: string;
  /** Fail on cache misses instead of fetching upstream. */
  offline?: boolean;
  headless?: boolean;
  /** Chromium binary; defaults to Playwright's, or $SANDBURG_CHROMIUM. */
  executablePath?: string;

}

export interface RunOptions {
  runtime?: string;
  /** Checks, or the path of a checks file whose default export maps names to check functions. */
  checks?: string | Checks;
  /** Results go to <outDir>/<runId>/. Default: .sandburg/runs */
  outDir?: string;
  /** CSS selector that must match a rendered element before checks start. */
  readySelector?: string;
  timeouts?: Partial<Record<PhaseName | 'check', number>>;
  /** Keep the tab open after checks until it is closed (for `sandburg open`, with a headed browser). */
  hold?: boolean;
}

export const DEFAULT_TIMEOUTS: Record<PhaseName | 'check', number> = {
  probe: 5_000,
  load: 30_000,
  mount: 30_000,
  install: 60_000,
  start: 60_000,
  ready: 90_000,
  checks: 180_000,
  check: 30_000,
  dispose: 10_000,
};

/** Blocks any request that escapes the gateway: the proxy address is unroutable. */
const DEAD_PROXY = 'http://127.0.0.1:9';

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

export class Session {
  private options: SessionOptions;
  private browser: Browser | null = null;
  private host = new HostServer();
  private egress: EgressGateway;
  readonly store: SnapshotStore;

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.store = new SnapshotStore(resolve(options.storeDir ?? '.sandburg/store'));
    this.egress = new EgressGateway({
      cacheDir: resolve(options.cacheDir ?? '.sandburg/cache'),
      offline: options.offline ?? false,
    });
  }

  async open(): Promise<void> {
    await this.host.listen();
    this.browser = await chromium.launch(launchOptions(this.options));
  }

  async close(): Promise<void> {
    await this.browser?.close();
    await this.host.close();
    await this.egress.close();
  }

  async run(projectInput: string | Project, options: RunOptions = {}): Promise<RunResult> {
    if (!this.browser) throw new Error('session is not open');
    const runId = `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const outDir = resolve(options.outDir ?? '.sandburg/runs', runId);
    await mkdir(outDir, { recursive: true });
    const adapter = getAdapter(options.runtime ?? 'almostnode');
    const project = typeof projectInput === 'string' ? await loadProject(projectInput, this.store) : projectInput;
    await this.store.put(project.files, project.name);
    const checks = typeof options.checks === 'string' ? await loadChecks(options.checks) : (options.checks ?? null);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

    const run = new RunState(runId, project, adapter, this.options.offline ?? false, this.browser.version());
    let context: BrowserContext | null = null;
    try {
      run.probe = await run.phase('probe', timeouts.probe, async () => adapter.probe(project));
      if (run.probe.verdict === 'unsupported') {
        run.skipRemaining();
        return await run.finish(outDir);
      }

      const sandboxId = runId.toLowerCase();
      const origin = this.host.register(sandboxId, adapter);
      context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
      run.network = await this.egress.attach(context, origin, adapter.egress);
      const page = await context.newPage();
      run.capture(page, origin);

      const ok = await run.phase('load', timeouts.load, async () => {
        await page.goto(origin + '/');
        await page.waitForSelector('html[data-sandburg="ready"]', { state: 'attached' });
        return true;
      }).catch(() => false);
      const host = <K extends keyof HostApi>(name: K, ...args: Parameters<HostApi[K]>) =>
        page.evaluate(([n, a]) => (window.__sandburg[n] as (...x: unknown[]) => Promise<RpcResult<unknown>>)(...a), [name, args] as const).then(unwrap);

      if (ok) {
        const steps = async () => {
          await run.phase('mount', timeouts.mount, () => host('mount', project.files, project.packageJson, project.framework));
          run.install = (await run.phase('install', timeouts.install, () => host('install'))) as InstallReport;
          const { url } = (await run.phase('start', timeouts.start, () => host('start'))) as { url: string };
          const app = await run.phase('ready', timeouts.ready, async () => {
            await host('ready', url);
            const frame = await appFrame(page);
            await failFastOnAppError(waitForRender(frame, options.readySelector), () =>
              run.pageErrors.find((e) => e.source === 'app'),
            );
            return frame;
          });
          const output = await run.phase('checks', timeouts.checks, () =>
            runChecks({
              page,
              app,
              checks,
              checkTimeoutMs: timeouts.check,
              artifactsDir: outDir,
              appErrors: () => run.pageErrors.filter((e) => e.source === 'app'),
              appConsole: () => run.console.filter((c) => c.source === 'app'),
              network: () => ({ failed: run.network?.failed ?? [], blocked: run.network?.blocked ?? [] }),
            }),
          );
          run.checksOutput = output;
          if (options.hold) await page.waitForEvent('close', { timeout: 0 });
        };
        await steps().catch(() => {}); // failures are recorded per phase
        await run.phase('dispose', timeouts.dispose, () => host('dispose')).catch(() => {});
      }
      run.skipRemaining();
      return await run.finish(outDir);
    } finally {
      await context?.close().catch(() => {});
      this.host.unregister(runId.toLowerCase());
    }
  }
}

/** Chromium launch options. Exported so tests can check the network backstop without the gateway. */
export function launchOptions(options: SessionOptions): LaunchOptions {
  return {
    headless: options.headless ?? true,
    executablePath: options.executablePath ?? process.env.SANDBURG_CHROMIUM,
    // Only sandbox origins bypass the dead proxy. Leading "<-loopback>" is required for
    // Chromium to honor the rule for *.localhost; it also keeps plain 127.0.0.1 blocked.
    proxy: { server: DEAD_PROXY, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}` },
  };
}

/** Convenience: open a session, run one project, close. */
export async function runProject(project: string | Project, options: RunOptions & SessionOptions = {}): Promise<RunResult> {
  const session = new Session(options);
  await session.open();
  try {
    return await session.run(project, options);
  } finally {
    await session.close();
  }
}

class RunState {
  phases: PhaseRecord[] = [];
  probe: ProbeVerdict | null = null;
  install: InstallReport | null = null;
  checksOutput: ChecksOutput | null = null;
  network: EgressStats | null = null;
  console: ConsoleEntry[] = [];
  pageErrors: PageError[] = [];
  infraError: { phase: PhaseName; message: string } | null = null;
  private startedAt = new Date();
  private t0 = performance.now();
  private runId: string;
  private project: Project;
  private adapter: AdapterDescriptor;
  private offline: boolean;
  private browserVersion: string;

  constructor(runId: string, project: Project, adapter: AdapterDescriptor, offline: boolean, browserVersion: string) {
    this.runId = runId;
    this.project = project;
    this.adapter = adapter;
    this.offline = offline;
    this.browserVersion = browserVersion;
  }

  /** Runs one lifecycle phase under a deadline and records its outcome. Rethrows on failure. */
  async phase<T>(name: PhaseName, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PhaseTimeout(name, timeoutMs)), timeoutMs);
      });
      const value = await Promise.race([fn(), deadline]);
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

  skipRemaining(): void {
    const order: PhaseName[] = ['probe', 'load', 'mount', 'install', 'start', 'ready', 'checks', 'dispose'];
    for (const name of order) {
      if (!this.phases.some((p) => p.name === name)) this.phases.push({ name, status: 'skipped', durationMs: 0 });
    }
    this.phases.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  capture(page: Page, origin: string): void {
    const sourceOf = (url: string): 'app' | 'host' =>
      url.startsWith(`${origin}/__sandburg/`) || url.startsWith(`${origin}/__sw__`) || url.includes('esbuild-wasm') ? 'host' : 'app';
    page.on('console', (msg) => {
      if (this.console.length >= 500) return;
      const url = msg.location().url;
      this.console.push({ source: sourceOf(url), type: msg.type(), text: msg.text().slice(0, 2000), url: url || undefined });
    });
    page.on('pageerror', (err) => {
      if (this.pageErrors.length >= 100) return;
      const firstFrame = /(https?:\/\/[^\s)]+)/.exec(err.stack ?? '')?.[1] ?? '';
      this.pageErrors.push({ source: sourceOf(firstFrame), message: err.message, stack: err.stack });
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
      infraError: this.infraError,
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
      runtime: { name: this.adapter.name, version: this.adapter.version },
      environment: {
        sandburgVersion: SANDBURG_VERSION,
        browser: `chromium ${this.browserVersion}`,
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
    await writeFile(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  }
}

function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new RpcError(result.error);
  return result.value;
}

async function appFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('#app');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('app frame is not attached');
  return frame;
}

/** Adapter-agnostic readiness: the app rendered something visible. */
async function waitForRender(frame: Frame, selector?: string): Promise<void> {
  await frame.waitForFunction(
    (sel) => {
      if (sel) return !!document.querySelector(sel);
      const root = document.querySelector('#root, #app, #__next');
      if (root) return root.childElementCount > 0;
      return (document.body?.innerText ?? '').trim().length > 0;
    },
    selector ?? null,
    { polling: 100, timeout: 0 },
  );
}

/** How long the app may keep trying to render after an uncaught error. */
const RENDER_GRACE_MS = 2_000;

/**
 * Rejects if the app throws and still has not rendered after a grace period,
 * so a broken app fails `ready` with its own error instead of timing out.
 */
async function failFastOnAppError(render: Promise<void>, firstError: () => PageError | undefined): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const watch = new Promise<never>((_, reject) => {
    const poll = () => {
      const err = firstError();
      if (err) timer = setTimeout(() => reject(new Error(`app threw before rendering: ${err.message}`)), RENDER_GRACE_MS);
      else timer = setTimeout(poll, 100);
    };
    poll();
  });
  try {
    await Promise.race([render, watch]);
  } finally {
    clearTimeout(timer);
  }
}

function isInfra(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target (page|crashed|closed)|Browser has been closed|browser has disconnected|offline mode:/i.test(msg);
}

function serialize(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, code: typeof code === 'string' ? code : undefined, stack: err.stack };
  }
  return { name: 'Error', message: String(err) };
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}

export type { Checks };
