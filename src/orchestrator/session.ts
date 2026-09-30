/**
 * A session owns the browser, the host server and the egress gateway. Runs in
 * a session share them; each run gets its own browser context, tab and origin.
 */
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Frame, type LaunchOptions, type Page } from 'playwright-core';
import { DEFAULT_RUNTIME, getAdapter } from '../adapters.ts';
import { classify } from '../classify.ts';
import { loadProject } from '../project.ts';
import type {
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
import { EgressGateway, newEgressStats, originMatcher, type EgressStats } from './egress.ts';
import { EgressProxy } from './egress-proxy.ts';
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
  /**
   * PEM bundle of extra CAs the browser should accept for tunneled HTTPS, for
   * networks whose egress proxy re-terminates TLS. Default: $SANDBURG_EXTRA_CA_CERTS,
   * then $NODE_EXTRA_CA_CERTS (what Node already trusts). Their public keys are
   * pinned with --ignore-certificate-errors-spki-list: only chains containing one
   * of these keys are accepted in addition to the normal trust store.
   */
  extraCaCerts?: string | null;

}

/**
 * A runtime that runs outside the browser (for example the Docker reference):
 * it serves the app on a loopback port, and the tab loads it directly.
 */
export interface NodeRuntime {
  name: string;
  version: string;
  /** Origins the app page may reach besides its own (usually none). */
  egress: string[];
  probe(project: Project): ProbeVerdict;
  /** Prepares, installs and starts the app; returns the loopback port it listens on. */
  mount(project: Project, log: (line: string) => void): Promise<void>;
  install(): Promise<InstallReport>;
  start(): Promise<{ port: number }>;
  /** Log lines (install and dev-server output), for results and classification. */
  logs(): string[];
  dispose(): Promise<void>;
}

export interface RunOptions {
  /** In-browser runtime adapter name, or `auto` (the default) to choose one per project. Ignored when nodeRuntime is set. */
  runtime?: string;
  /** Run in an out-of-browser runtime instead (e.g. the Docker reference); called once per run. */
  nodeRuntime?: () => NodeRuntime;
  /** Checks, or the path of a checks file whose default export maps names to check functions. */
  checks?: string | Checks;
  /** Results go to <outDir>/<runId>/. Default: .sandburg/runs */
  outDir?: string;
  /** CSS selector that must match a rendered element before checks start. */
  readySelector?: string;
  timeouts?: Partial<Record<PhaseName | 'check' | 'expect', number>>;
  /** Re-run a project whose run failed as infra (a flaky download, a crashed tab) this many times. Default 1. */
  infraRetries?: number;
  /** Keep the tab open after checks until it is closed (for `sandburg open`, with a headed browser). */
  hold?: boolean;
  /** Internal: this run is a seed of shared caches (see HostInstallOptions.seed). */
  seed?: boolean;
}

export const DEFAULT_TIMEOUTS: Record<PhaseName | 'check' | 'expect', number> = {
  probe: 5_000,
  load: 30_000,
  mount: 30_000,
  install: 60_000,
  start: 60_000,
  ready: 90_000,
  checks: 180_000,
  check: 30_000,
  /** Default timeout of expect() assertions in checks (Playwright's default). */
  expect: 5_000,
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
    const previous: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const result = await this.runOnce(projectInput, options);
      if (result.failure?.class !== 'infra' || attempt >= (options.infraRetries ?? 1) || options.hold) {
        if (previous.length) {
          result.previousAttempts = previous;
          const outDir = resolve(options.outDir ?? '.sandburg/runs', result.runId);
          await writeFile(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        }
        return result;
      }
      previous.push(result.runId);
    }
  }

  /**
   * Runs the runtime's warm-up projects whose installs are missing (see adapters/node/warmup.ts),
   * side by side, and returns their names. On a warm machine it only checks.
   */
  async prewarm(options: { runtime?: string; log?: (line: string) => void } = {}): Promise<string[]> {
    const adapter = getAdapter(options.runtime ?? DEFAULT_RUNTIME);
    const cold: Project[] = [];
    for (const project of adapter.warmups?.() ?? []) if (!(await adapter.isWarm?.(project))) cold.push(project);
    if (!cold.length) return [];
    options.log?.(`warming up ${cold.map((p) => p.name).join(', ')} (once per machine)`);
    // A warm-up that fails costs its batch little: it only makes later apps slower.
    const timeouts = { start: 60_000, ready: 60_000 };
    await Promise.all(cold.map((p) => this.run(p, { runtime: options.runtime, outDir: resolve('.sandburg/warmup'), infraRetries: 0, timeouts })));
    return cold.map((p) => p.name);
  }

  /** Runs a seed project (see HostInstallOptions.runSeed); its result goes to .sandburg/seeds. */
  private async runSeed(project: Project, checks: Checks, parent: RunOptions): Promise<void> {
    const result = await this.runOnce(project, { runtime: parent.runtime, checks, seed: true, infraRetries: 0, outDir: resolve('.sandburg/seeds') });
    if (result.status !== 'passed') throw new Error(`seed ${project.name} did not pass: ${result.failure?.message ?? result.status}`);
  }

  private async runOnce(projectInput: string | Project, options: RunOptions): Promise<RunResult> {
    if (!this.browser) throw new Error('session is not open');
    const runId = `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const outDir = resolve(options.outDir ?? '.sandburg/runs', runId);
    await mkdir(outDir, { recursive: true });
    const project = typeof projectInput === 'string' ? await loadProject(projectInput, this.store) : projectInput;
    const node = options.nodeRuntime?.() ?? null;
    const adapter = node ? null : getAdapter(options.runtime ?? DEFAULT_RUNTIME);
    const runtimeInfo = node ?? adapter!;
    await this.store.put(project.files, project.name);
    const checks = typeof options.checks === 'string' ? await loadChecks(options.checks) : (options.checks ?? null);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...adapter?.timeouts, ...options.timeouts };

    const run = new RunState(runId, project, runtimeInfo, this.options.offline ?? false, this.browser.version());
    let context: BrowserContext | null = null;
    let proxy: EgressProxy | null = null;
    try {
      run.probe = await run.phase('probe', timeouts.probe, async () => runtimeInfo.probe(project));
      if (run.probe.verdict === 'unsupported') {
        run.skipRemaining();
        return await run.finish(outDir);
      }

      // Requests routing cannot see (service worker scripts, for one) use the context's own
      // proxy credentials, which select this sandbox's allowlist in the egress proxy.
      run.network = newEgressStats();
      const allow = runtimeInfo.egress;
      const runtimeAllow = originMatcher(allow);
      proxy = new EgressProxy(originMatcher(allow), run.network);
      await proxy.listen();
      context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        proxy: { server: proxy.server, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}` },
      });
      recordRequestFailures(context, run);
      recordDocuments(context, run);
      const page = await context.newPage();
      if (node) {
        await this.runNode(node, run, context, page, project, runId, outDir, timeouts, checks, options);
        run.skipRemaining();
        return await run.finish(outDir);
      }
      const sandboxId = runId.toLowerCase();
      const origin = this.host.register(sandboxId, adapter!);
      await this.egress.attach(context, origin, allow, run.network);
      run.capture(page, origin);

      const ok = await run.phase('load', timeouts.load, async () => {
        // The host page lives under /__sandburg/ so the app can own "/" (ADR 0004).
        await page.goto(origin + '/__sandburg/');
        await page.waitForSelector('html[data-sandburg="ready"]', { state: 'attached' });
        return true;
      }).catch(() => false);
      const host = <K extends keyof HostApi>(name: K, ...args: Parameters<HostApi[K]>) =>
        page.evaluate(([n, a]) => (window.__sandburg[n] as (...x: unknown[]) => Promise<RpcResult<unknown>>)(...a), [name, args] as const).then(unwrap);

      if (ok) {
        const steps = async () => {
          const watch = <T>(p: Promise<T>) => failFastOnRuntimeFetch(p, run, runtimeAllow);
          await run.phase('mount', timeouts.mount, () => watch(host('mount', project.files, project.packageJson, project.framework)));
          run.install = (await run.phase('install', timeouts.install, async () => {
            const hostData = adapter!.hostInstall
              ? await adapter!.hostInstall(project, (line) => run.runtimeLogs.push(line), {
                  seed: options.seed,
                  runSeed: options.seed ? undefined : (seed, checks) => this.runSeed(seed, checks as Checks, options),
                })
              : undefined;
            return watch(host('install', hostData));
          })) as InstallReport;
          const { url, navigate } = (await run.phase('start', timeouts.start, () => watch(host('start')))) as { url: string; navigate?: boolean };
          const app = await run.phase('ready', timeouts.ready, async () => {
            await host('ready', url, navigate ?? true);
            const frame = await appFrame(page);
            await failFastOnAppError(waitForRender(frame, options.readySelector), run);
            return frame;
          });
          // The app is idle: no request in flight and the runtime quiet for a moment (see settlingExpect).
          const appIdle = async () => {
            const a = (await host('activity')) as { inflight: number; idleMs: number } | null;
            return !!a && a.inflight === 0 && a.idleMs >= APP_IDLE_MS;
          };
          await runChecksPhase(run, page, app, checks, timeouts, outDir, options, appIdle);
        };
        await steps().catch(() => {}); // failures are recorded per phase
        await run.phase('dispose', timeouts.dispose, () => host('dispose')).catch(() => {});
      }
      run.skipRemaining();
      return await run.finish(outDir);
    } finally {
      await context?.close().catch(() => {});
      await proxy?.close();
      this.host.unregister(runId.toLowerCase());
    }
  }

  /** Lifecycle for an out-of-browser runtime: start it, load its port in the tab, check. */
  private async runNode(
    node: NodeRuntime,
    run: RunState,
    context: BrowserContext,
    page: Page,
    project: Project,
    runId: string,
    outDir: string,
    timeouts: Record<PhaseName | 'check' | 'expect', number>,
    checks: Checks | null,
    options: RunOptions,
  ): Promise<void> {
    const logs: string[] = [];
    try {
      await run.phase('load', timeouts.load, async () => {}); // no host page
      await run.phase('mount', timeouts.mount, () => node.mount(project, (l) => logs.push(l)));
      run.install = await run.phase('install', timeouts.install, () => node.install());
      const { port } = await run.phase('start', timeouts.start, () => node.start());
      // *.sandburg.localhost resolves to loopback and bypasses the proxy.
      const origin = `http://${runId.toLowerCase()}-ref.${SANDBOX_DOMAIN}:${port}`;
      await this.egress.attach(context, origin, node.egress, run.network ?? undefined);
      run.capture(page, origin);
      const app = await run.phase('ready', timeouts.ready, async () => {
        await page.goto(origin + '/', { waitUntil: 'load', timeout: timeouts.ready });
        await failFastOnAppError(waitForRender(page.mainFrame(), options.readySelector), run);
        return page.mainFrame();
      });
      await runChecksPhase(run, page, app, checks, timeouts, outDir, options);
    } catch {
      // failures are recorded per phase
    } finally {
      run.runtimeLogs = node.logs();
      await run.phase('dispose', timeouts.dispose, () => node.dispose()).catch(() => {});
    }
  }
}

async function runChecksPhase(
  run: RunState,
  page: Page,
  app: Frame,
  checks: Checks | null,
  timeouts: Record<PhaseName | 'check' | 'expect', number>,
  outDir: string,
  options: RunOptions,
  appIdle?: () => Promise<boolean>,
): Promise<void> {
  run.checksOutput = await run.phase('checks', timeouts.checks, () =>
    runChecks({
      page,
      app,
      checks,
      checkTimeoutMs: timeouts.check,
      expectTimeoutMs: timeouts.expect,
      appIdle,
      artifactsDir: outDir,
      appErrors: () => run.pageErrors.filter((e) => e.source === 'app'),
      appConsole: () => run.console.filter((c) => c.source === 'app'),
      network: () => ({ failed: run.network?.failed ?? [], blocked: run.network?.blocked ?? [] }),
      appDocument: () => run.documents.filter((d) => d.frame === app).at(-1) ?? null,
    }),
  );
  if (options.hold) await page.waitForEvent('close', { timeout: 0 });
}

/** How long the runtime must have been quiet, with no request in flight, for the app to count as idle. */
const APP_IDLE_MS = 1_500;

/** Chromium launch options. Exported so tests can check the network backstop without the gateway. */
export function launchOptions(options: SessionOptions): LaunchOptions {
  const ca = options.extraCaCerts === undefined ? (process.env.SANDBURG_EXTRA_CA_CERTS ?? process.env.NODE_EXTRA_CA_CERTS) : options.extraCaCerts;
  const spki = ca ? spkiHashes(ca) : [];
  return {
    headless: options.headless ?? true,
    args: spki.length ? [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] : [],
    executablePath: options.executablePath ?? process.env.SANDBURG_CHROMIUM,
    // Default for contexts without their own egress-proxy credentials: only sandbox origins
    // bypass the dead proxy. Leading "<-loopback>" is required for
    // Chromium to honor the rule for *.localhost; it also keeps plain 127.0.0.1 blocked.
    proxy: { server: DEAD_PROXY, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}` },
  };
}

/** Grace period after a runtime asset fails before the phase gives up (the runtime may retry). */
const RUNTIME_FETCH_GRACE_MS = 3_000;

/**
 * Rejects when one of the runtime's own assets (an allowlisted origin) fails to
 * load in the browser, so a flaky download fails the phase quickly as infra
 * instead of waiting out its deadline.
 */
async function failFastOnRuntimeFetch<T>(work: Promise<T>, run: RunState, allow: (origin: string) => boolean): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watch = new Promise<never>((_, reject) => {
    let deadline = 0;
    let reason = '';
    const poll = () => {
      if (!deadline) {
        const f = run.network?.failed.find((e) => e.reason.startsWith('browser:') && URL.canParse(e.url) && allow(new URL(e.url).origin));
        // Also: a rate limit or server error on a script, e.g. a runtime's service worker registration.
        const limited = run.console.find((c) => c.type === 'error' && /bad HTTP response code \((429|5\d\d)\)/.test(c.text));
        if (f) [deadline, reason] = [Date.now() + RUNTIME_FETCH_GRACE_MS, `runtime asset failed to load: ${f.url} (${f.reason})`];
        else if (limited) [deadline, reason] = [Date.now() + RUNTIME_FETCH_GRACE_MS, `runtime asset failed to load: ${limited.text}`];
      } else if (Date.now() >= deadline) {
        reject(new Error(reason));
        return;
      }
      timer = setTimeout(poll, 200);
    };
    poll();
  });
  try {
    return await Promise.race([work, watch]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Requests that failed in the browser for reasons other than the gateway's own
 * blocking (DNS, TLS, resets, a service worker's fetch failing).
 */
function recordRequestFailures(context: BrowserContext, run: RunState): void {
  context.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? 'failed';
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(reason) || !run.network || run.network.failed.length >= 100) return;
    run.network.failed.push({ url: req.url(), method: req.method(), reason: `browser: ${reason}` });
  });
}

/** The status of each document the app's frames load (a server-rendered error page is a 5xx). */
function recordDocuments(context: BrowserContext, run: RunState): void {
  context.on('response', (res) => {
    const req = res.request();
    if (!req.isNavigationRequest() || run.documents.length >= 200) return;
    run.documents.push({ frame: res.frame(), url: res.url(), status: res.status() });
  });
}

/** base64 sha256 of each certificate's SubjectPublicKeyInfo, as Chromium's SPKI list expects. */
function spkiHashes(pemPath: string): string[] {
  const pem = readFileSync(pemPath, 'utf8');
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((c) =>
    createHash('sha256').update(new X509Certificate(c).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
  );
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
  documents: { frame: Frame; url: string; status: number }[] = [];
  infraError: { phase: PhaseName; message: string } | null = null;
  /** Output of an out-of-browser runtime (install and server logs), used as classification evidence. */
  runtimeLogs: string[] = [];
  private startedAt = new Date();
  private t0 = performance.now();
  private runId: string;
  private project: Project;
  private runtime: { name: string; version: string };
  private offline: boolean;
  private browserVersion: string;

  constructor(runId: string, project: Project, runtime: { name: string; version: string }, offline: boolean, browserVersion: string) {
    this.runId = runId;
    this.project = project;
    this.runtime = { name: runtime.name, version: runtime.version };
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
      runtimeErrors: [
        ...this.console.filter((c) => c.source === 'host' && c.type === 'error').map((c) => c.text),
        ...this.runtimeLogs,
      ],
      runtimeOutput: this.console.filter((c) => c.source === 'host' && /^\[runtime:std(?:out|err)\]/.test(c.text)).map((c) => c.text),
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
      runtime: this.runtime,
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
    if (this.runtimeLogs.length) {
      result.artifacts.runtimeLog = join(outDir, 'runtime.log');
      await writeFile(result.artifacts.runtimeLog, this.runtimeLogs.join('\n') + '\n');
    }
    await writeFile(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  }
}

function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new RpcError(result.error);
  return result.value;
}

/** The frame the app renders in: the host's #app iframe. */
async function appFrame(page: Page): Promise<Frame> {
  const frame = await (await page.waitForSelector('#app')).contentFrame();
  if (!frame) throw new Error('app frame is not attached');
  return frame;
}

/** Adapter-agnostic readiness: the app rendered something visible. */
async function waitForRender(frame: Frame, selector?: string): Promise<void> {
  await frame.waitForFunction(
    (sel) => {
      if (sel) return !!document.querySelector(sel);
      const root = document.querySelector('#root, #app, #__next');
      // Rendered: elements, or text (an app may set only textContent).
      if (root) return root.childElementCount > 0 || (root.textContent ?? '').trim().length > 0;
      return (document.body?.innerText ?? '').trim().length > 0;
    },
    selector ?? null,
    { polling: 100, timeout: 0 },
  );
}

/** How long the app may keep trying to render after an uncaught error. */
const RENDER_GRACE_MS = 2_000;
/** Console errors (a 404'd module, a failed import) are weaker evidence: wait longer. */
const CONSOLE_GRACE_MS = 8_000;
/** Console noise that says nothing about whether the app can render. */
const BENIGN_CONSOLE = /favicon\.ico|Download the React DevTools/i;

/**
 * Rejects if the app throws (or logs a console error) and still has not
 * rendered after a grace period, so a broken app fails `ready` with its own
 * error instead of timing out. A module that 404s, for example, fails
 * silently except for a console error.
 */
async function failFastOnAppError(render: Promise<void>, run: RunState): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const watch = new Promise<never>((_, reject) => {
    let deadline = 0;
    let reason = '';
    const poll = () => {
      if (!deadline) {
        const err = run.pageErrors.find((e) => e.source === 'app');
        const logged = run.console.find((c) => c.source === 'app' && c.type === 'error' && !BENIGN_CONSOLE.test(`${c.text} ${c.url ?? ''}`));
        if (err) [deadline, reason] = [Date.now() + RENDER_GRACE_MS, `app threw before rendering: ${err.message}`];
        else if (logged) [deadline, reason] = [Date.now() + CONSOLE_GRACE_MS, `app did not render after a console error: ${logged.text}${logged.url ? ` (${logged.url})` : ''}`];
      } else if (Date.now() >= deadline) {
        reject(new Error(reason));
        return;
      }
      timer = setTimeout(poll, 100);
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
  return /Target (page|crashed|closed)|Browser has been closed|browser has disconnected|offline mode:|Cannot connect to the Docker daemon/i.test(msg);
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
