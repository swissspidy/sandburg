/**
 * A session owns the browser, the host server and the egress gateway. Runs in
 * a session share them; each run gets its own browser context, tab and origin.
 */
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type LaunchOptions, type Page } from 'playwright-core';
import { DEFAULT_RUNTIME, getAdapter } from '../adapters.ts';
import type { AdapterDescriptor } from '../types.ts';
import { classify } from '../classify.ts';
import { loadProject } from '../project.ts';
import type {
  ConsoleEntry,
  FileTree,
  InstallReport,
  PageError,
  PhaseName,
  PhaseRecord,
  ProbeVerdict,
  Project,
  RunResult,
  SerializedError,
} from '../types.ts';
import type { HostApi, RpcResult } from '../host/types.ts';
import { loadChecks, runChecks, type Checks, type ChecksOutput } from './checks.ts';
import { loadPageChecks, type PageChecks } from '../page-checks/index.ts';
import { EgressGateway, newEgressStats, originMatcher, record, type EgressStats } from './egress.ts';
import { EgressProxy } from './egress-proxy.ts';
import { AXE_CLASSIC_PATH, AXE_SCRIPT, HostServer, SANDBOX_DOMAIN } from './host-server.ts';
import { CodeCache, type PageCode } from './code-cache.ts';
import { SANDBURG_VERSION } from '../version.ts';
import { SnapshotStore } from '../store.ts';
import { RendererMemory } from './renderer-memory.ts';
import { collectGarbage, type DevtoolsSession } from './collect-garbage.ts';

/** Options of a Session: the browser, the caches and stores it keeps on disk. */
export interface SessionOptions {
  /** Directory for the HTTP cache. Default: .sandburg/cache */
  cacheDir?: string;
  /** Directory of the snapshot store. Default: .sandburg/store */
  storeDir?: string;
  /** Directory for V8's compiled code of the host's own scripts (code-cache.ts), or null for none on disk. Default: .sandburg/code-cache */
  codeCacheDir?: string | null;
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
  /**
   * Keep a tab ready for the next run (default: true): its browser context, egress routes and host
   * page are set up, and its runtime loaded, ahead of the run (see Tab). False: each run opens its
   * own when it starts.
   */
  spareTab?: boolean;
}

/**
 * A run's tab: its own browser context (with the egress proxy and routes that police it), and the
 * sandbox's host page loading in it. A session opens the next run's tab ahead of time (a spare), so
 * a run starts with its host page loaded and its runtime evaluated (prepare() in the host page).
 */
interface Tab {
  /** The sandbox's id: the first DNS label of its origin. */
  id: string;
  origin: string;
  adapter: AdapterDescriptor;
  context: BrowserContext;
  page: Page;
  proxy: EgressProxy;
  network: EgressStats;
  /** The host page has loaded (the load phase's work). */
  loaded: Promise<void>;
  /** The tab crashed or failed to load before a run took it. */
  broken: boolean;
  /** axe-core's compiled code, given to the page once its host page has loaded (code-cache.ts). */
  code?: PageCode;
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

/** Options of one run (Session.run): the runtime, the checks, where results go, deadlines. */
export interface RunOptions {
  /** In-browser runtime adapter name, or `auto` (the default) to choose one per project. Ignored when nodeRuntime is set. */
  runtime?: string;
  /** Run in an out-of-browser runtime instead (e.g. the Docker reference); called once per run. */
  nodeRuntime?: () => NodeRuntime;
  /**
   * Checks, or the path of a checks file whose default export maps names to check functions, or a
   * checks file loaded to run in the page (loadPageChecks).
   */
  checks?: string | Checks | PageChecks;
  /**
   * Where a checks file (a path in `checks`) runs: 'host' (imported here, the default) or 'page'
   * (its code runs in the sandbox tab, with Playwright-shaped locators and expect: for checks
   * written by someone who may not run code on this machine; ADR 0023).
   */
  checksIn?: 'host' | 'page';
  /** Results go to <outDir>/<runId>/. Default: .sandburg/runs */
  outDir?: string;
  /** CSS selector that must match a rendered element before checks start. */
  readySelector?: string;
  /**
   * A failing assertion stops waiting once the app is idle, after at least 5 s (ADR 0016). Default:
   * true. False: every assertion waits its whole timeout.
   */
  failFastChecks?: boolean;
  timeouts?: Partial<Record<PhaseName | 'check' | 'expect', number>>;
  /** Re-run a project whose run failed as infra (a flaky download, a crashed tab) this many times. Default 1. */
  infraRetries?: number;
  /** Keep the tab open after checks until it is closed (for `sandburg open`, with a headed browser). */
  hold?: boolean;
  /** Internal: this run is a seed of shared caches (see HostInstallOptions.seed). */
  seed?: boolean;
  /**
   * Where dependencies are installed: 'host' (npm on the host, the default) or 'browser' (opt-in:
   * the page resolves and fetches packages from the npm registry itself; see node-runtime/npm).
   */
  installIn?: 'host' | 'browser';
  /**
   * After the checks, the app's files whose path matches this pattern (a RegExp source), as they
   * are in the runtime then, go to onAppFiles: for example its SQLite databases, to mount them into
   * the next run as the generator page does. In-browser runtimes only.
   */
  collectFiles?: string;
  onAppFiles?: (files: FileTree) => void;
  /** Called as each lifecycle phase of the run starts (a batch starts its next app when one reaches its checks). */
  onPhase?: (phase: PhaseName) => void;
  /**
   * Called once the run has its tab, with its renderer (see RunRenderer): what a batch's memory
   * guard reads of each open app, and asks of those in their checks when memory is short.
   */
  onRenderer?: (renderer: RunRenderer) => void;
}

/** A run's renderer, for a batch (RunOptions.onRenderer). */
export interface RunRenderer {
  /** Bytes it uses now; null until it is found, and where its memory cannot be read (not Linux). */
  used(): number | null;
  /**
   * A full garbage collection in each of the run's isolates (collectGarbage), each given
   * GC_TIMEOUT_MS; resolves when done (never rejects; a no-op once the run is over).
   */
  collectGarbage(): Promise<void>;
}

/** Each phase's deadline in milliseconds, a check's, and an expect() assertion's (RunOptions.timeouts overrides them). */
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

/**
 * A browser and the host's services (the host server, the egress gateway, caches) that runs
 * project after project, each in its own browser context and origin. open() it, run() projects
 * (concurrently if you like), close() it.
 */
export class Session {
  private options: SessionOptions;
  private browser: Browser | null = null;
  private host = new HostServer();
  private egress: EgressGateway;
  private codeCache: CodeCache | null = null;
  readonly store: SnapshotStore;
  /** The browser's own DevTools session (the renderers' pids and CPU times; see rendererMemory). */
  private browserCdp: Promise<CDPSession> | null = null;

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.store = new SnapshotStore(resolve(options.storeDir ?? '.sandburg/store'));
    this.egress = new EgressGateway({
      cacheDir: resolve(options.cacheDir ?? '.sandburg/cache'),
      offline: options.offline ?? false,
    });
  }

  /** Starts the browser and the host server. Call once, before run(). */
  async open(): Promise<void> {
    // While the browser launches: the host gets ready for a first install (npm loaded).
    getAdapter(DEFAULT_RUNTIME).prepare?.();
    await this.host.listen();
    try {
      const launch = launchOptions(this.options);
      this.browser = await chromium.launch(launch);
      const dir = this.options.codeCacheDir === undefined ? '.sandburg/code-cache' : this.options.codeCacheDir;
      this.codeCache = new CodeCache(this.browser, (launch.args ?? []).join(' '), dir === null ? null : resolve(dir));
    } catch (err) {
      await this.host.close();
      throw missingBrowser(err) ?? err;
    }
    // axe-core's compiled code, for the checks of every run (read from disk, or produced in a context of its own).
    void this.codeCache.prepare(AXE_SCRIPT);
    // The first run's tab opens while the run loads its project and the host installs it.
    this.prepareTab(getAdapter(DEFAULT_RUNTIME));
  }

  /** The next run's tab, opening (see Tab). */
  private spare: Promise<Tab> | null = null;

  /** Opens a spare tab for the next run on `adapter`, unless there is one. */
  private prepareTab(adapter: AdapterDescriptor): void {
    // Not with a visible browser: a spare is a window.
    if (this.spare || this.options.spareTab === false || this.options.headless === false || !this.browser) return;
    // No deadline of its own: the run that takes it waits for it within its own load timeout.
    const spare = this.openTab(adapter, 0);
    spare.then(
      (tab) => tab.loaded.catch(() => (tab.broken = true)),
      () => {},
    );
    this.spare = spare;
  }

  /** The spare tab if it is for `adapter` and still usable, else a new one. */
  private async takeTab(adapter: AdapterDescriptor, loadTimeoutMs: number): Promise<Tab> {
    const spare = this.spare;
    this.spare = null;
    const tab = await spare?.catch(() => null);
    if (tab && tab.adapter === adapter && !tab.broken && !tab.page.isClosed()) return tab;
    if (tab) void this.closeTab(tab);
    return this.openTab(adapter, loadTimeoutMs);
  }

  /** A new browser context with its egress proxy and routes, and its host page loading. */
  private async openTab(adapter: AdapterDescriptor, loadTimeoutMs: number): Promise<Tab> {
    const browser = this.browser;
    if (!browser) throw new Error('session is not open');
    const id = `s-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const network = newEgressStats();
    // Requests the gateway does not see go to the context's own egress proxy, which polices them
    // with this sandbox's allowlist. The gateway intercepts HTTPS for the runtime's contexts: nothing
    // else needs a tunnel there.
    const proxy = new EgressProxy(originMatcher(adapter.egress), network, { noTunnels: true });
    await proxy.listen();
    let context: BrowserContext | null = null;
    try {
      // Only the host server's port on *.sandburg.localhost bypasses the proxy: the gateway does not
      // see plain HTTP (see EgressGateway.attach).
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        proxy: { server: proxy.server, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}:${this.host.port}` },
      });
      await context.addInitScript(PAGE_QUIET_SCRIPT);
      const page = await context.newPage();
      const origin = this.host.register(id, adapter);
      await this.egress.attach(context, origin, adapter.egress, network);
      // The host page lives under /__sandburg/ so the app can own "/" (ADR 0004).
      const loaded = (async () => {
        await page.goto(origin + '/__sandburg/', { timeout: loadTimeoutMs });
        await page.waitForSelector('html[data-sandburg="ready"]', { state: 'attached', timeout: loadTimeoutMs });
      })();
      loaded.catch(() => {}); // the load phase reports it
      const tab: Tab = { id, origin, adapter, context, page, proxy, network, loaded, broken: false };
      page.on('crash', () => (tab.broken = true));
      const codeCache = this.codeCache;
      if (codeCache) loaded.then(() => (tab.code = codeCache.attach(page, AXE_SCRIPT, origin + AXE_CLASSIC_PATH)), () => {});
      return tab;
    } catch (err) {
      await context?.close().catch(() => {});
      await proxy.close();
      this.host.unregister(id);
      throw err;
    }
  }

  /**
   * The memory of a tab's renderer (see RendererMemory), read from /proc: Linux only. The page's
   * DevTools session is the tab's own and ends with its context.
   */
  private rendererMemory(tab: Tab): RendererMemory | null {
    const browser = this.browser;
    if (process.platform !== 'linux' || !browser) return null;
    let page: Promise<CDPSession> | null = null;
    return new RendererMemory({
      pageCpu: async () => {
        page ??= tab.context.newCDPSession(tab.page).then(async (s) => (await s.send('Performance.enable'), s));
        const { metrics } = await (await page).send('Performance.getMetrics');
        const cpu = metrics.find((m) => m.name === 'ProcessTime')?.value;
        if (cpu === undefined) throw new Error('no ProcessTime');
        return cpu;
      },
      renderers: async () => {
        this.browserCdp ??= browser.newBrowserCDPSession();
        const { processInfo } = (await (await this.browserCdp).send('SystemInfo.getProcessInfo'));
        return processInfo.filter((p) => p.type === 'renderer').map((p) => ({ pid: p.id, cpuSeconds: p.cpuTime }));
      },
      release: () => {
        void page?.then((s) => s.detach()).catch(() => {});
        page = null;
      },
    });
  }

  private async closeTab(tab: Tab): Promise<void> {
    await tab.context.close().catch(() => {});
    await tab.proxy.close();
    this.host.unregister(tab.id);
  }

  /** Waits for the host installs and seed runs it started, then closes the browser and the host's servers. */
  async close(): Promise<void> {
    // A seed run started beside an app (adapters/node/index.ts) finishes first: later runs start from it.
    // So does a host install still running (started before the browser context, so a run that
    // failed before its install phase may not have waited for it).
    while (this.installs.size) await Promise.allSettled([...this.installs]);
    await this.seeded();
    const spare = await this.spare?.catch(() => null);
    this.spare = null;
    if (spare) await this.closeTab(spare);
    this.browserCdp = null;
    await this.browser?.close();
    await this.host.close();
    await this.egress.close();
  }

  /**
   * Runs a project (a path, "snapshot:<id>" or a Project) through its phases and checks, and returns
   * its result (also written to <outDir>/<runId>/result.json). A run that fails as infra is
   * retried (RunOptions.infraRetries).
   */
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
    // The seeds the warm-ups started, so the batch's apps start from them.
    await this.seeded();
    return cold.map((p) => p.name);
  }

  /** Host installs in progress (see runOnce). */
  private installs = new Set<Promise<unknown>>();

  /** Seed runs in progress. */
  private seeds = new Set<Promise<void>>();

  /** Waits for the seed runs in progress (whether they pass or not). */
  private async seeded(): Promise<void> {
    while (this.seeds.size) await Promise.allSettled([...this.seeds]);
  }

  /** Runs a seed project (see HostInstallOptions.runSeed); its result goes to .sandburg/seeds. */
  private runSeed(project: Project, checks: Checks, parent: RunOptions): Promise<void> {
    const seed = (async () => {
      const result = await this.runOnce(project, { runtime: parent.runtime, checks, seed: true, infraRetries: 0, outDir: resolve('.sandburg/seeds') });
      if (result.status !== 'passed') throw new Error(`seed ${project.name} did not pass: ${result.failure?.message ?? result.status}`);
    })();
    this.seeds.add(seed);
    void seed.catch(() => {}).finally(() => this.seeds.delete(seed));
    return seed;
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
    const checks =
      typeof options.checks === 'string'
        ? await (options.checksIn === 'page' ? loadPageChecks(options.checks) : loadChecks(options.checks))
        : (options.checks ?? null);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...adapter?.timeouts, ...options.timeouts };

    const run = new RunState(runId, project, runtimeInfo, this.options.offline ?? false, this.browser.version());
    run.onPhase = options.onPhase;
    let context: BrowserContext | null = null;
    let proxy: EgressProxy | null = null;
    let tab: Tab | null = null;
    let memory: RendererMemory | null = null;
    let sampler: NodeJS.Timeout | undefined;
    let sampling = false;
    let stopped = false;
    try {
      run.probe = await run.phase('probe', timeouts.probe, async () => runtimeInfo.probe(project));
      if (run.probe.verdict === 'unsupported') {
        run.skipRemaining();
        return await run.finish(outDir);
      }

      // The host's half of the install (npm, on a cold machine) starts now, while the tab and the host
      // page load: the install phase waits for it.
      // The sandbox the run's page is in, once its tab is taken: what the install issues to the run is bound to it.
      let bindSandbox: (id: string) => void = () => {};
      const sandbox = new Promise<string>((resolve) => (bindSandbox = resolve));
      const hostInstall = adapter?.hostInstall?.(project, (line) => run.runtimeLogs.push(line), {
        seed: options.seed,
        sandbox,
        installIn: options.installIn,
        runSeed: options.seed ? undefined : (seed, checks) => this.runSeed(seed, checks as Checks, options),
      });
      if (hostInstall) {
        this.installs.add(hostInstall);
        void hostInstall.catch(() => {}).finally(() => this.installs.delete(hostInstall)); // reported by the install phase
      }

      if (node) {
        // Requests the gateway does not see go to the context's own egress proxy, which polices them
        // with this sandbox's allowlist. The reference runtime's app is on a port of its own.
        run.network = newEgressStats();
        proxy = new EgressProxy(originMatcher(node.egress), run.network);
        await proxy.listen();
        context = await this.browser.newContext({
          viewport: { width: 1280, height: 800 },
          proxy: { server: proxy.server, bypass: `<-loopback>,*.${SANDBOX_DOMAIN}` },
        });
        recordRequestFailures(context, run);
        recordDocuments(context, run);
        await context.addInitScript(PAGE_QUIET_SCRIPT);
        const page = await context.newPage();
        await this.runNode(node, run, context, page, project, runId, outDir, timeouts, checks, options);
        run.skipRemaining();
        return await run.finish(outDir);
      }
      const runtimeAllow = originMatcher(adapter!.egress);
      // The spare tab, with its host page loaded or loading; the next run's opens meanwhile.
      tab = await this.takeTab(adapter!, timeouts.load);
      bindSandbox(tab.id);
      // Not for a seed run (it runs beside an app), nor a held one.
      if (!options.seed && !options.hold) this.prepareTab(adapter!);
      ({ context, proxy } = tab);
      const { page, origin } = tab;
      memory = this.rendererMemory(tab);
      if (memory) {
        const m = memory;
        // Looked for as the app starts: its renderer holds ~50 MB until then (the host page), and
        // looking costs the page a little while it mounts and installs. Looked for again soon while
        // other renderers fit too (tabs that opened together); then read for its peak.
        const sample = async () => {
          const found = await m.locate();
          if (found) m.used();
          if (!stopped) sampler = setTimeout(() => void sample(), found ? RENDERER_SAMPLE_MS : RENDERER_LOCATE_MS);
        };
        run.onPhase = (phase) => {
          options.onPhase?.(phase);
          if (phase !== 'start' || sampling) return;
          sampling = true;
          void sample();
        };
      }
      const t = tab;
      options.onRenderer?.({
        used: () => memory?.used() ?? null,
        collectGarbage: async () => {
          if (t.page.isClosed()) return;
          const cdp = await t.context.newCDPSession(t.page).catch(() => null);
          if (!cdp) return;
          await collectGarbage(cdp as unknown as DevtoolsSession, GC_TIMEOUT_MS).catch(() => {});
          await cdp.detach().catch(() => {});
        },
      });
      run.memory = memory;
      run.network = tab.network;
      recordRequestFailures(context, run);
      recordDocuments(context, run);
      run.capture(page, origin);

      const ok = await run.phase('load', timeouts.load, async () => {
        await tab!.loaded;
        return true;
      }).catch(() => false);
      const host = <K extends keyof HostApi>(name: K, ...args: Parameters<HostApi[K]>) =>
        page.evaluate(([n, a]) => (window.__sandburg[n] as (...x: unknown[]) => Promise<RpcResult<unknown>>)(...a), [name, args] as const).then(unwrap);

      if (ok) {
        const steps = async () => {
          const watch = <T>(p: Promise<T>) => failFastOnRuntimeFetch(p, run, runtimeAllow);
          await run.phase('mount', timeouts.mount, () => watch(host('mount', project.files, project.packageJson, project.framework)));
          run.install = (await run.phase('install', timeouts.install, async () => {
            const hostData = hostInstall ? await hostInstall : undefined;
            return watch(host('install', hostData));
          })) as InstallReport;
          const { url, navigate } = (await run.phase('start', timeouts.start, () => watch(host('start')))) as { url: string; navigate?: boolean };
          const app = await run.phase('ready', timeouts.ready, async () => {
            await host('ready', url, navigate ?? true);
            const frame = await appFrame(page);
            // A dev server that answers 503 while it builds (Nuxt's "Dev server is loading...") shows a loading page.
            const loading = () => run.documents.filter((d) => d.frame === frame).at(-1)?.status === 503;
            const loadingPage = async () => loading() || (await frame.evaluate(() => document.documentElement.outerHTML.includes('__NUXT_LOADING__')).catch(() => false));
            const rendered = () => host('rendered', options.readySelector ?? null) as Promise<boolean>;
            await failFastOnAppError(waitForRender(frame, options.readySelector, navigate === false ? undefined : () => host('ready', url, true), loading, rendered), run, loadingPage);
            return frame;
          });
          // The app is idle (see settlingExpect): its servers have no request in flight and have been
          // quiet for a moment, and its page has no timer due before the assertion's time is up and
          // has not changed for a moment (PAGE_QUIET_SCRIPT).
          const appIdle = async (remainingMs: number) => {
            const a = (await host('activity')) as { inflight: number; idleMs: number } | null;
            if (!a || a.inflight > 0 || a.idleMs < APP_IDLE_MS) return false;
            const q = await app.evaluate((h) => window.__sandburgQuiet?.(h) ?? null, remainingMs);
            return !!q && q.quiet && q.sinceChangeMs >= APP_IDLE_MS;
          };
          const appSettled = () => host('settled', SETTLE_QUIET_MS, SETTLE_LONG_MS, SETTLE_MAX_MS);
          await runChecksPhase(run, page, app, checks, timeouts, outDir, options, options.failFastChecks === false ? undefined : appIdle, origin, appSettled, tab?.code);
        };
        await steps().catch(() => {}); // failures are recorded per phase
        if (options.collectFiles && options.onAppFiles) {
          const files = await page
            .evaluate((match) => window.__sandburgReadFiles?.(match) ?? null, options.collectFiles)
            .catch(() => null);
          if (files) options.onAppFiles(files);
        }
        await run.phase('dispose', timeouts.dispose, () => host('dispose')).catch(() => {});
      }
      run.skipRemaining();
      return await run.finish(outDir);
    } finally {
      stopped = true;
      clearTimeout(sampler);
      memory?.stop();
      if (tab) await this.closeTab(tab);
      else {
        await context?.close().catch(() => {});
        await proxy?.close();
      }
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
    checks: Checks | PageChecks | null,
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
      await this.egress.attach(context, origin, node.egress, run.network ?? undefined, { routeAll: true });
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
  checks: Checks | PageChecks | null,
  timeouts: Record<PhaseName | 'check' | 'expect', number>,
  outDir: string,
  options: RunOptions,
  appIdle?: (remainingMs: number) => Promise<boolean>,
  hostOrigin?: string,
  appSettled?: () => Promise<unknown>,
  axeCode?: PageCode,
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
      hostOrigin,
      appSettled,
      axeCode,
    }),
  );
  if (options.hold) await page.waitForEvent('close', { timeout: 0 });
}

/**
 * Runs first in every document of a run: tracks the page's pending timeouts and when it last changed,
 * for settlingExpect (window.__sandburgQuiet(horizonMs)). An app that will update itself from a timer
 * due within the assertion's remaining time is not idle.
 */
export const PAGE_QUIET_SCRIPT = `(() => {
  if (window.__sandburgQuiet) return;
  const pending = new Map();
  const set = window.setTimeout, clear = window.clearTimeout;
  window.setTimeout = function (fn, ms, ...rest) {
    if (typeof fn !== 'function') return set.call(this, fn, ms, ...rest);
    let id;
    id = set.call(this, function (...a) { pending.delete(id); return fn.apply(this, a); }, ms, ...rest);
    pending.set(id, performance.now() + (Number(ms) || 0));
    return id;
  };
  window.clearTimeout = function (id) { pending.delete(id); return clear.call(this, id); };
  let changed = performance.now();
  new MutationObserver(() => { changed = performance.now(); }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  window.__sandburgQuiet = (horizonMs) => {
    const now = performance.now();
    for (const due of pending.values()) if (due <= now + horizonMs) return { quiet: false, sinceChangeMs: now - changed };
    return { quiet: true, sinceChangeMs: now - changed };
  };
})();`;

/**
 * Before the functional checks, the app settles (host/settle.ts): its framework says input is no
 * longer lost, or else no request from the page for SETTLE_QUIET_MS and none in flight sent within
 * SETTLE_LONG_MS (an event stream or a long poll stays open); at most SETTLE_MAX_MS, waited for beside
 * the artifacts. SvelteKit and Nuxt went on loading client modules for 0.3-1.6 s after they rendered
 * on the server, and a click before they hydrated did nothing.
 */
const SETTLE_QUIET_MS = 100;
const SETTLE_LONG_MS = 1_000;
const SETTLE_MAX_MS = 3_000;

/** How long each of a run's isolates has to answer a garbage collection (a blocked worker answers nothing). */
const GC_TIMEOUT_MS = 2_000;

/** How often a run reads its renderer's memory once found (for the peak), and looks for it until then. */
const RENDERER_SAMPLE_MS = 1_000;
const RENDERER_LOCATE_MS = 250;

/** How long the runtime must have been quiet, with no request in flight, for the app to count as idle. */
const APP_IDLE_MS = 1_500;

/**
 * Playwright's own advice for a missing browser (`npx playwright install`) runs the latest
 * Playwright, whose Chromium build may not be the one the Playwright installed with Sandburg drives.
 */
function missingBrowser(err: unknown): Error | null {
  if (!(err instanceof Error) || !err.message.includes("Executable doesn't exist")) return null;
  const { version } = createRequire(import.meta.url)('playwright-core/package.json') as { version: string };
  return new Error(`Chromium for Playwright ${version} is not installed. Run: npx playwright@${version} install chromium (on Linux, add --with-deps for its system libraries), or set SANDBURG_CHROMIUM to a Chromium binary.`);
}

/**
 * How long a WebAssembly function runs before V8 compiles optimized code for it. Every run compiles
 * the dev tools' WebAssembly builds (esbuild, SWC, rolldown) anew, in its own browser context. At
 * V8's default (13M, a rough count of bytes executed), esbuild's Go build had ~35 functions
 * optimized in a warm Vite run: 2.5 s of CPU on background threads, for a run that took 3.5 s, while
 * the runtime's thread waited for cores. At 100 times the default, only code that keeps running (a
 * long build, an edit loop) is optimized. Warm runs took 20-37% less time (Vite, Next.js, SvelteKit,
 * Angular); turning optimization off altogether (--liftoff-only) helped Vite but not Next.js' SWC.
 */
const WASM_TIERING_BUDGET = 1_300_000_000;

/** Chromium launch options. Exported so tests can check the network backstop without the gateway. */
export function launchOptions(options: SessionOptions): LaunchOptions {
  const ca = options.extraCaCerts === undefined ? (process.env.SANDBURG_EXTRA_CA_CERTS ?? process.env.NODE_EXTRA_CA_CERTS) : options.extraCaCerts;
  const spki = ca ? spkiHashes(ca) : [];
  return {
    headless: options.headless ?? true,
    args: [`--js-flags=--wasm-tiering-budget=${WASM_TIERING_BUDGET}`, ...(spki.length ? [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] : [])],
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
    record(run.network.failed, { url: req.url(), method: req.method(), reason: `browser: ${reason}` });
  });
}

/** The status of each document the app's frames load (a server-rendered error page is a 5xx). */
function recordDocuments(context: BrowserContext, run: RunState): void {
  context.on('response', (res) => {
    const req = res.request();
    if (!req.isNavigationRequest() || run.documents.length >= 200) return;
    run.documents.push({ frame: res.frame(), url: res.url(), status: res.status(), csp: 'content-security-policy' in res.headers() });
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
  documents: { frame: Frame; url: string; status: number; csp?: boolean }[] = [];
  infraError: { phase: PhaseName; message: string } | null = null;
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

  constructor(runId: string, project: Project, runtime: { name: string; version: string }, offline: boolean, browserVersion: string) {
    this.runId = runId;
    this.project = project;
    this.runtime = { name: runtime.name, version: runtime.version };
    this.offline = offline;
    this.browserVersion = browserVersion;
  }

  /** Runs one lifecycle phase under a deadline and records its outcome. Rethrows on failure. */
  onPhase?: (phase: PhaseName) => void;

  async phase<T>(name: PhaseName, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    this.onPhase?.(name);
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
    // An install in the browser fetches from the npm registry, and looks up names that may not exist
    // (napi-rs' wasm32-wasi packages): the browser logs those 404s, and they are not the app's.
    const sourceOf = (url: string): 'app' | 'host' =>
      url.startsWith(`${origin}/__sandburg/`) || url.startsWith(`${origin}/__sw__`) || url.includes('esbuild-wasm') || url.startsWith('https://registry.npmjs.org/') ? 'host' : 'app';
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
    this.memory?.used(); // a last look, for the peak
    if (this.memory?.peak) result.memory = { rendererPeakBytes: this.memory.peak };
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

/**
 * Adapter-agnostic readiness: the app rendered something visible. Two pages are not the app yet:
 * the browser's own error page ("refused to connect"), when a dev server takes its port before it
 * can answer (Nuxt 4.6 does), and a dev server's loading page: Nuxt's, marked __NUXT_LOADING__,
 * which reloads itself once the app is built, or any 503 answer (`loading`). The app is loaded
 * again until it renders or the phase's deadline passes. `rendered` asks the host page first (one call,
 * where Playwright's waitForFunction first sets itself up in the new frame), if there is one.
 */
async function waitForRender(frame: Frame, selector?: string, reload?: () => Promise<unknown>, loading?: () => boolean, rendered?: () => Promise<boolean>): Promise<void> {
  if (rendered && (await rendered().catch(() => false)) && !loading?.()) return;
  for (let tries = 1; ; tries++) {
    // The run ended (the phase timed out and the tab closed): stop trying.
    if (frame.isDetached() || frame.page().isClosed()) throw new Error('the app frame is gone');
    const state = await frame
      .waitForFunction(
        (sel) => {
          if (location.protocol === 'chrome-error:') return false;
          if (document.documentElement.outerHTML.includes('__NUXT_LOADING__')) return false;
          if (sel) return !!document.querySelector(sel);
          const root = document.querySelector('#root, #app, #__next');
          // Rendered: elements, or text (an app may set only textContent).
          if (root) return root.childElementCount > 0 || (root.textContent ?? '').trim().length > 0;
          return (document.body?.innerText ?? '').trim().length > 0;
        },
        selector ?? null,
        { polling: 100, timeout: RELOAD_ERROR_PAGE_MS },
      )
      .then(
        () => 'rendered' as const,
        () => (frame.url().startsWith('chrome-error:') ? ('error' as const) : ('waiting' as const)),
      );
    if (state === 'rendered' && !loading?.()) return;
    // The error page at once; a loading page after a while, in case its own reload does not come.
    if (reload && (state === 'error' || tries % RELOAD_LOADING_PAGE_TRIES === 0)) await reload().catch(() => {});
  }
}

/** A loading page that has not reloaded itself is loaded again after this many seconds. */
const RELOAD_LOADING_PAGE_TRIES = 5;
/** How often an app frame that shows the browser's error page is loaded again while waiting for it to render. */
const RELOAD_ERROR_PAGE_MS = 1_000;

/** How long the app may keep trying to render after an uncaught error. */
const RENDER_GRACE_MS = 2_000;
/** Console errors (a 404'd module, a failed import) are weaker evidence: wait longer. */
const CONSOLE_GRACE_MS = 8_000;
/** Console noise that says nothing about whether the app can render (chrome-error: the browser's error page, loaded again; see waitForRender). */
const BENIGN_CONSOLE = /favicon\.ico|Download the React DevTools|chrome-error:/i;

/**
 * Rejects if the app throws (or logs a console error) and still has not
 * rendered after a grace period, so a broken app fails `ready` with its own
 * error instead of timing out. A module that 404s, for example, fails
 * silently except for a console error.
 */
async function failFastOnAppError(render: Promise<void>, run: RunState, loadingPage?: () => Promise<boolean>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // What a dev server's loading page logs (Nuxt answers 503 while it builds) is not the app's.
  let seenErrors = 0;
  let seenConsole = 0;
  let done = false;
  const watch = new Promise<never>((_, reject) => {
    let deadline = 0;
    let reason = '';
    const poll = async () => {
      if (!deadline && loadingPage && (await loadingPage())) [seenErrors, seenConsole] = [run.pageErrors.length, run.console.length];
      if (done) return;
      if (!deadline) {
        const err = run.pageErrors.slice(seenErrors).find((e) => e.source === 'app');
        // The page's own 503 is a dev server still loading (see waitForRender), not the app failing.
        const loading503 = (c: ConsoleEntry) => !!c.url && run.documents.some((d) => d.status === 503 && d.url === c.url);
        const logged = run.console.slice(seenConsole).find((c) => c.source === 'app' && c.type === 'error' && !BENIGN_CONSOLE.test(`${c.text} ${c.url ?? ''}`) && !loading503(c));
        if (err) [deadline, reason] = [Date.now() + RENDER_GRACE_MS, `app threw before rendering: ${err.message}`];
        else if (logged) [deadline, reason] = [Date.now() + CONSOLE_GRACE_MS, `app did not render after a console error: ${logged.text}${logged.url ? ` (${logged.url})` : ''}`];
      } else if (Date.now() >= deadline) {
        reject(new Error(reason));
        return;
      }
      timer = setTimeout(() => void poll(), 100);
    };
    void poll();
  });
  try {
    await Promise.race([render, watch]);
  } finally {
    done = true;
    clearTimeout(timer);
    // What a loading page logged belongs to the dev server, not to the app the checks look at.
    for (const e of run.pageErrors.slice(0, seenErrors)) e.source = 'host';
    for (const c of run.console.slice(0, seenConsole)) if (c.source === 'app') c.source = 'host';
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
