/**
 * A session owns the browser, the host server and the egress gateway. Runs in
 * a session share them; each run gets its own browser context, tab and origin.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright-core';
import { DEFAULT_RUNTIME, getAdapter } from '../adapters.ts';
import type { AdapterDescriptor } from '../types.ts';
import { loadProject, projectFromFiles } from '../project.ts';
import type { FileTree, InstallReport, PhaseName, ProbeVerdict, Project, RunResult } from '../types.ts';
import type { HostApi, RpcResult } from '../host/types.ts';
import { ChecksProgress, loadChecks, runChecks, type Checks } from './checks.ts';
import { loadPageChecks, type PageChecks } from '../page-checks/index.ts';
import { EgressGateway, newEgressStats, originMatcher, type EgressStats } from './egress.ts';
import { EgressProxy } from './egress-proxy.ts';
import { AXE_CLASSIC_PATH, AXE_SCRIPT, HostServer, SANDBOX_DOMAIN } from './host-server.ts';
import { CodeCache, type PageCode } from './code-cache.ts';
import { NO_SNAPSHOT, SnapshotStore } from '../store.ts';
import { pageRendererMemory, type RendererMemory } from './renderer-memory.ts';
import { collectGarbage, type DevtoolsSession } from './collect-garbage.ts';
import { traceTransfer, tracingTransfers } from '../transfer-trace.ts';
import { browserSandbox, missingBrowser, launchOptions, sandboxUnavailable } from './launch.ts';
import { recordRequestFailures, recordDocuments, RunState, unwrap } from './run-state.ts';
import { failFastOnRuntimeFetch, appFrame, waitForRender, failFastOnAppError } from './app-ready.ts';
import { appFilesFrom } from './app-files.ts';

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
   * Run Chromium inside its OS sandbox. Default: true, unless $SANDBURG_NO_BROWSER_SANDBOX is 1.
   * Where the sandbox cannot start (as root; where user namespaces are restricted), open() fails and
   * says so: there is no fallback to running without it. False turns it off; each run's result
   * records which (environment.browserSandbox).
   */
  browserSandbox?: boolean;
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
  /** Phase deadlines this runtime needs instead of the defaults (RunOptions.timeouts still override them). */
  timeouts?: Partial<Record<PhaseName, number>>;
  probe(project: Project): ProbeVerdict;
  /** Prepares, installs and starts the app; returns the loopback port it listens on. A phase's error with `infra: true` (the runtime itself could not run) classes the run infra. */
  mount(project: Project, log: (line: string) => void): Promise<void>;
  install(): Promise<InstallReport>;
  start(): Promise<{ port: number }>;
  /** Log lines (install and dev-server output), for results and classification. */
  logs(): string[];
  dispose(): Promise<void>;
}

/** Options of one run (Session.run): the runtime, the checks, where results go, deadlines. */
export interface RunOptions {
  /** In-browser runtime adapter name (`adapterNames`); `node`, the only one, by default. Ignored when nodeRuntime is set. */
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
  /**
   * Keep the tab open after the run until it is closed (for `sandburg open`, with a headed browser),
   * also when a phase before the checks failed.
   */
  hold?: boolean;
  /**
   * Where dependencies are installed: 'host' (npm on the host, the default) or 'browser' (opt-in:
   * the page resolves and fetches packages from the npm registry itself; see adapters/node/browser-npm).
   */
  installIn?: 'host' | 'browser';
  /**
   * After the checks, the app's files whose path matches this pattern (a RegExp source), as they
   * are in the runtime then, go to onAppFiles: for example its SQLite databases, to mount them into
   * the next run as the generator page does. In-browser runtimes only. They come from the page: the
   * host keeps only matching relative paths outside node_modules, dot directories and .git; over
   * 1000 files or 256 MB, none, and `refused` says why (see orchestrator/app-files.ts). An invalid
   * pattern fails run() before the run starts.
   */
  collectFiles?: string;
  onAppFiles?: (files: FileTree, refused?: string) => void;
  /** Called as each lifecycle phase of the run starts (a batch starts its next app when one reaches its checks). */
  onPhase?: (phase: PhaseName) => void;
  /**
   * Called once the run has its tab, with its renderer (see RunRenderer): what a batch's memory
   * guard reads of each open app, and asks of those in their checks when memory is short.
   */
  onRenderer?: (renderer: RunRenderer) => void;
  /**
   * Called when the run starts a seed run beside it (a cold Next.js install's, ADR 0037), whose tab
   * has a renderer of its own (up to 1.4 GB): the seed run's phases and renderer go to the
   * callbacks it returns, and `ended` once it is over. A batch's memory guard counts it as another
   * open app.
   */
  onSeed?: () => Pick<RunOptions, 'onPhase' | 'onRenderer'> & { ended(): void };
}

/** A run's options as the session gives them to runOnce: a seed run is the session's own (runSeed). */
interface RunOnceOptions extends RunOptions {
  /** This run is a seed of shared caches (see HostInstallOptions.seed). */
  seed?: boolean;
}

/** A run's renderer, for a batch (RunOptions.onRenderer). */
export interface RunRenderer {
  /** Bytes it uses now; null until it is found, and where its memory cannot be read (not Linux). */
  used(): number | null;
  /** The most it was seen to use so far (bytes); null until it is found, and where its memory cannot be read. */
  peak?(): number | null;
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

  /** The browser runs inside Chromium's OS sandbox (SessionOptions.browserSandbox, or its default). */
  readonly browserSandbox: boolean;

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.browserSandbox = browserSandbox(options);
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
      const launch = launchOptions({ ...this.options, browserSandbox: this.browserSandbox });
      this.browser = await chromium.launch(launch);
      const dir = this.options.codeCacheDir === undefined ? '.sandburg/code-cache' : this.options.codeCacheDir;
      this.codeCache = new CodeCache(this.browser, (launch.args ?? []).join(' '), dir === null ? null : resolve(dir));
    } catch (err) {
      await this.host.close();
      throw missingBrowser(err) ?? sandboxUnavailable(err) ?? err;
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
    // Unique, not secret: see HostServer.register.
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
    if (!browser) return null;
    return pageRendererMemory(tab.page, () => (this.browserCdp ??= browser.newBrowserCDPSession()), this.browserSandbox);
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
    if (options.collectFiles !== undefined) {
      try {
        new RegExp(options.collectFiles);
      } catch (err) {
        throw new Error(`collectFiles: ${(err as Error).message}`);
      }
    }
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
  private runSeed(project: Project, checks: Checks, parent: RunOnceOptions): Promise<void> {
    const watch = parent.onSeed?.();
    const seed = (async () => {
      const result = await this.runOnce(project, { runtime: parent.runtime, checks, seed: true, infraRetries: 0, outDir: resolve('.sandburg/seeds'), onPhase: watch?.onPhase, onRenderer: watch?.onRenderer });
      if (result.status !== 'passed') throw new Error(`seed ${project.name} did not pass: ${result.failure?.message ?? result.status}`);
    })().finally(() => watch?.ended());
    this.seeds.add(seed);
    void seed.catch(() => {}).finally(() => this.seeds.delete(seed));
    return seed;
  }

  private async runOnce(projectInput: string | Project, options: RunOnceOptions): Promise<RunResult> {
    if (!this.browser) throw new Error('session is not open');
    const runId = `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const outDir = resolve(options.outDir ?? '.sandburg/runs', runId);
    const adapter = options.nodeRuntime ? null : getAdapter(options.runtime ?? DEFAULT_RUNTIME);
    // A project or checks file that does not load ends this run as an error, not its batch.
    const failedSetup = async (project: Project, rule: 'project-load' | 'checks-load', err: unknown, appBug = false) => {
      const failed = new RunState(runId, project, adapter ?? options.nodeRuntime!(), this.options.offline ?? false, this.browser!.version(), this.browserSandbox);
      failed.failSetup(rule, err, appBug);
      failed.skipRemaining();
      await mkdir(outDir, { recursive: true });
      return failed.finish(outDir);
    };
    let project: Project;
    try {
      project = typeof projectInput === 'string' ? await loadProject(projectInput, this.store) : projectInput;
    } catch (err) {
      const path = projectInput as string;
      const snapshot = path.startsWith('snapshot:');
      const project = { ...projectFromFiles({}, { name: snapshot ? path : basename(path), path: snapshot ? path : resolve(path) }), snapshotId: NO_SNAPSHOT };
      // A path or snapshot that is not there is not the app's bug; a file that is no project is.
      const missing = snapshot || (err as NodeJS.ErrnoException).code === 'ENOENT';
      return failedSetup(project, 'project-load', err, !missing);
    }
    // Stored before its checks load, so that a run whose checks file is broken can be reopened.
    await this.store.put(project.files, project.name);
    let checks: Checks | PageChecks | null;
    try {
      checks =
        typeof options.checks === 'string'
          ? await (options.checksIn === 'page' ? loadPageChecks(options.checks) : loadChecks(options.checks))
          : (options.checks ?? null);
    } catch (err) {
      return failedSetup(project, 'checks-load', err);
    }
    await mkdir(outDir, { recursive: true });
    const node = options.nodeRuntime?.() ?? null;
    const runtimeInfo = node ?? adapter!;
    const timeouts = { ...DEFAULT_TIMEOUTS, ...runtimeInfo.timeouts, ...options.timeouts };

    const run = new RunState(runId, project, runtimeInfo, this.options.offline ?? false, this.browser.version(), this.browserSandbox);
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
        peak: () => memory?.peak || null,
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
      // Large arguments (the install data) are fetched by the page from the host server (HostServer.stash).
      const host = <K extends keyof HostApi>(name: K, ...args: Parameters<HostApi[K]>) => {
        const json = args.length && !(args as unknown[]).includes(undefined) ? JSON.stringify(args) : '';
        const stash = json.length > STASH_ABOVE ? this.host.stash(tab!.id, json) : null;
        return traced(`evaluate ${name}`, stash ? [stash] : args, () =>
          page.evaluate(
            async ([n, a, from]) => (window.__sandburg[n] as (...x: unknown[]) => Promise<RpcResult<unknown>>)(...(from ? ((await (await fetch(from)).json()) as unknown[]) : a)),
            [name, stash ? [] : args, stash] as const,
          ),
        ).then(unwrap);
      };

      if (ok) {
        const steps = async () => {
          const watch = <T>(p: Promise<T>) => failFastOnRuntimeFetch(p, run, runtimeAllow);
          await run.phase('mount', timeouts.mount, () => watch(host('mount', project.files, project.packageJson, project.framework)));
          run.install = (await run.phase('install', timeouts.install, async () => {
            const hostData = hostInstall ? await hostInstall : undefined;
            return watch(host('install', hostData));
          })) as InstallReport;
          const { url, navigate } = (await run.phase('start', timeouts.start, () => watch(host('start')))) as { url: string; navigate?: boolean };
          run.appPath = URL.canParse(url) ? new URL(url).pathname : null;
          const app = await run.phase('ready', timeouts.ready, async () => {
            // The host page's frame for the app, there before the app loads into it.
            const frame = await appFrame(page);
            // A dev server that answers 503 while it builds (Nuxt's "Dev server is loading...") shows a loading page.
            const loading = () => run.documents.filter((d) => d.frame === frame).at(-1)?.status === 503;
            const loadingPage = async () => loading() || (await frame.evaluate(() => document.documentElement.outerHTML.includes('__NUXT_LOADING__')).catch(() => false));
            const rendered = () => host('rendered', options.readySelector ?? null) as Promise<boolean>;
            // Watched from the first load on: a dev server that never answers the page's request (Angular's,
            // after its dependency optimizer crashed) never fires its load event, and reports the error meanwhile.
            const render = (async () => {
              await host('ready', url, navigate ?? true);
              await waitForRender(frame, options.readySelector, navigate === false ? undefined : () => host('ready', url, true), loading, rendered);
            })();
            await failFastOnAppError(render, run, loadingPage, frame);
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
          const appSettled = () => host('settled', SETTLE_QUIET_MS, SETTLE_LONG_MS, SETTLE_MAX_MS, SETTLE_HYDRATE_MAX_MS);
          await runChecksPhase(run, page, app, checks, timeouts, outDir, options.failFastChecks === false ? undefined : appIdle, origin, appSettled, tab?.code);
        };
        await steps().catch(() => {}); // failures are recorded per phase
        // Whether the app reached its checks or not, it stays up until its window is closed.
        if (options.hold) await closed(page);
        if (options.collectFiles && options.onAppFiles) {
          const files = await page
            .evaluate((match) => window.__sandburgReadFiles?.(match) ?? null, options.collectFiles)
            .catch(() => null);
          if (files) {
            const collected = appFilesFrom(files, options.collectFiles);
            options.onAppFiles(collected.files, collected.refused);
          }
        }
        await run.phase('dispose', timeouts.dispose, () => host('dispose')).catch(() => {});
      }
      run.skipRemaining();
      return await run.finish(outDir);
    } finally {
      stopped = true;
      clearTimeout(sampler);
      memory?.stop();
      // A host page that did not load is held open too (a no-op once its window was closed).
      if (options.hold && tab) await closed(tab.page);
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
      // The tab's routes and capture for the app's origin are part of starting it: an error there is the phase's.
      const origin = await run.phase('start', timeouts.start, async () => {
        const { port } = await node.start();
        // *.sandburg.localhost resolves to loopback and bypasses the proxy.
        const origin = `http://${runId.toLowerCase()}-ref.${SANDBOX_DOMAIN}:${port}`;
        await this.egress.attach(context, origin, node.egress, run.network ?? undefined, { routeAll: true });
        run.capture(page, origin);
        return origin;
      });
      const app = await run.phase('ready', timeouts.ready, async () => {
        await page.goto(origin + '/', { waitUntil: 'load', timeout: timeouts.ready });
        await failFastOnAppError(waitForRender(page.mainFrame(), options.readySelector), run, undefined, page.mainFrame());
        return page.mainFrame();
      });
      await runChecksPhase(run, page, app, checks, timeouts, outDir);
    } catch (err) {
      // failures are recorded per phase; one the runtime marks as its own is infra (see NodeRuntime)
      if ((err as { infra?: unknown })?.infra === true) run.infraError ??= { phase: run.phases.at(-1)?.name ?? 'mount', message: (err as Error).message };
    } finally {
      if (options.hold) await closed(page);
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
  appIdle?: (remainingMs: number) => Promise<boolean>,
  hostOrigin?: string,
  appSettled?: () => Promise<unknown>,
  axeCode?: PageCode,
): Promise<void> {
  const progress = new ChecksProgress();
  run.checksOutput = progress;
  let checking: Promise<unknown> = Promise.resolve();
  try {
    await run.phase('checks', timeouts.checks, (signal) =>
      (checking = runChecks({
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
        progress,
        signal,
      })),
    );
  } catch (err) {
    // Out of time (or broken): the checks were stopped. What they report as they stop is kept, for a
    // moment; then a check still running timed out, and one not started did not run.
    await Promise.race([checking.catch(() => {}), sleep(STOP_CHECKS_MS, undefined, { ref: false })]);
    progress.close(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Resolves once the page's window is closed (RunOptions.hold). */
async function closed(page: Page): Promise<void> {
  if (!page.isClosed()) await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

/** How long checks stopped at the phase's deadline have to report how far they got (the checks file in the page, the check that was running). */
const STOP_CHECKS_MS = 2_000;

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
/**
 * While the app's framework says it has not hydrated yet (host/settle.ts' inputSafe), up to this long
 * instead: a cold SolidStart page hydrated after more than 3 s, and a fill() before then was lost.
 */
const SETTLE_HYDRATE_MAX_MS = 10_000;

/** How long each of a run's isolates has to answer a garbage collection (a blocked worker answers nothing). */
const GC_TIMEOUT_MS = 2_000;

/** How often a run reads its renderer's memory once found (for the peak), and looks for it until then. */
const RENDERER_SAMPLE_MS = 1_000;
const RENDERER_LOCATE_MS = 250;

/** How long the runtime must have been quiet, with no request in flight, for the app to count as idle. */
const APP_IDLE_MS = 1_500;

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

/** Arguments larger than this (as JSON) go to the host page from the host server, not through page.evaluate. */
const STASH_ABOVE = 16 << 10;

/** A call into the host page, its arguments' and result's sizes traced (SANDBURG_TRACE_TRANSFERS: JSON, as Playwright serializes them). */
async function traced<T>(what: string, args: unknown, call: () => Promise<T>): Promise<T> {
  if (!tracingTransfers) return call();
  const t0 = performance.now();
  const out = await call();
  const ms = performance.now() - t0;
  traceTransfer({ hop: 'host→page evaluate', what, bytes: JSON.stringify(args ?? null).length, encoding: 'json', ms });
  traceTransfer({ hop: 'page→host evaluate', what, bytes: JSON.stringify(out ?? null).length, encoding: 'json', ms });
  return out;
}

export type { Checks };
