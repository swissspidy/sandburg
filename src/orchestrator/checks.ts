/**
 * Checks run in the sandbox tab against the app frame: user functional checks
 * plus built-in console, network, axe, accessibility-snapshot and screenshot.
 */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import type { Frame, Page } from 'playwright-core';
import type { CheckKind, CheckResult, CheckStatus, ConsoleEntry, NetworkEntry, PageError } from '../types.ts';
import { AXE_PATH } from './host-server.ts';
import type { PageCode } from './code-cache.ts';
import { PAGE_CHECKS_PATH, isPageChecks, loadPageChecksRuntime, runPageChecks, stopPageChecks, type PageChecks } from '../page-checks/index.ts';
import { signalCalls, withSignal } from './check-signal.ts';

/** What a check function is given: the app, its tab, Playwright's expect and a URL helper. */
export interface CheckContext {
  /** The app frame. Locators, getByRole etc. work as on a page. */
  app: Frame;
  /** The sandbox tab (host page). Prefer `app` for interacting with the app. */
  page: Page;
  expect: typeof expect;
  /**
   * Resolves an app path against the URL the app first loaded at, so checks
   * work whatever prefix the runtime serves the app under.
   * appUrl('/about') and appUrl('about') are the same.
   */
  appUrl(path: string): string;
  /**
   * Aborts when the check's time is up (its timeout, or the checks phase's). The check is stopped
   * then: the Playwright call it waits in fails, and so does any it makes after. Pass it to waits of
   * your own (a timer, a fetch) so they stop too.
   */
  signal: AbortSignal;
}

/** A check: it passes unless it throws (a failed expect() throws). */
export type CheckFn = (ctx: CheckContext) => Promise<void> | void;
/** Default export of a checks file: check name → function. */
export type Checks = Record<string, CheckFn>;

export async function loadChecks(file: string): Promise<Checks> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const checks = mod.default;
  if (!checks || typeof checks !== 'object' || Object.values(checks).some((fn) => typeof fn !== 'function')) {
    throw new Error(`${file}: default export must be an object mapping check names to functions`);
  }
  return checks as Checks;
}

export interface ChecksInput {
  page: Page;
  app: Frame;
  /** Checks to run here, or a checks file to run in the page (--checks-in page). */
  checks: Checks | PageChecks | null;
  checkTimeoutMs: number;
  /** Default timeout of expect() assertions. */
  expectTimeoutMs?: number;
  /**
   * Whether the app's servers are idle (no request in flight, nothing heard for a moment). A failing
   * assertion stops waiting once it has waited SETTLE_FLOOR_MS and the app is idle (see settlingExpect).
   */
  appIdle?: (remainingMs: number) => Promise<boolean>;
  artifactsDir: string;
  /** Read at the end so errors raised during functional checks count. */
  appErrors: () => PageError[];
  appConsole: () => ConsoleEntry[];
  network: () => { failed: NetworkEntry[]; blocked: NetworkEntry[] };
  /** The document the app frame shows (its last navigation), if it was seen. */
  appDocument?: () => { url: string; status: number; csp?: boolean } | null;
  /**
   * Resolves once the app has settled after it rendered (its servers had no request for a moment:
   * the client's modules are in, and an app that hydrates has hydrated), or has given up waiting.
   * The functional checks start then.
   */
  appSettled?: () => Promise<unknown>;
  /** The sandbox's origin, if the host server serves it: axe-core (AXE_PATH) and the page checks' runtime come from there. */
  hostOrigin?: string;
  /** The page's copy of axe-core's compiled code (code-cache.ts), for axe-core from the host's origin. */
  axeCode?: PageCode;
  /** Where the results go as they come: what the run keeps if the phase runs out of time. */
  progress?: ChecksProgress;
  /** Aborts when the checks phase is out of time: what is running stops, and nothing more starts. */
  signal?: AbortSignal;
}

export interface ChecksOutput {
  checks: CheckResult[];
  artifacts: { screenshot?: string; a11ySnapshot?: string };
}

/** A check to run, in its place among the run's checks. */
interface Planned {
  id: string;
  kind: CheckKind;
  name: string;
  blocking: boolean;
  /** When it started (performance.now()). */
  started?: number;
  /** What it gave, once it finished: one result, or a checks file's (--checks-in page). */
  results?: CheckResult[];
}

/**
 * A run's checks as they finish, in the order they are reported, and those still to come: a checks
 * phase that runs out of time keeps what finished, and the artifacts already written (close()).
 */
export class ChecksProgress implements ChecksOutput {
  checks: CheckResult[] = [];
  artifacts: ChecksOutput['artifacts'] = {};
  private planned: Planned[] = [];
  private closed = false;

  plan(id: string, kind: CheckKind, name: string, blocking: boolean): Planned {
    const check: Planned = { id, kind, name, blocking };
    this.planned.push(check);
    return check;
  }

  start(check: Planned): void {
    check.started ??= performance.now();
  }

  finish(check: Planned, results: CheckResult[]): void {
    if (this.closed) return;
    check.results = results;
    this.checks = this.planned.flatMap((c) => c.results ?? []);
  }

  /** The phase is over (`reason`): a check still running timed out, and one not started did not run. */
  close(reason: string): void {
    for (const c of this.planned) {
      if (c.results) continue;
      const { id, kind, name, blocking } = c;
      this.finish(c, [
        c.started === undefined
          ? { id, kind, name, blocking, durationMs: 0, status: 'skipped', message: `not run: ${reason}` }
          : { id, kind, name, blocking, durationMs: ms(c.started), status: 'failed', message: `timed out: ${reason}` },
      ]);
    }
    this.closed = true;
  }
}

/** Whether the run warned that checks cannot be stopped in their Playwright calls (once a process). */
let warned = false;

/** How long the checks file running in the page has to say how far it got, once the phase is out of time. */
const STOP_PAGE_CHECKS_MS = 1_000;
/** How long a check that timed out has to stop (its Playwright calls aborted) before the app is loaded again. */
const STOP_CHECK_MS = 1_000;

/**
 * Runs the checks, each recorded in `input.progress` as it finishes. When `input.signal` aborts (the
 * phase's deadline), what is running stops and nothing more starts. A functional check gets
 * `checkTimeoutMs`: then it is stopped (its signal aborts, which aborts the Playwright call it waits
 * in, and refuses any it makes after), and the app is loaded again at the URL it first loaded at, so
 * what the check left half done does not reach the next one.
 */
export async function runChecks(input: ChecksInput): Promise<ChecksOutput> {
  const progress = input.progress ?? new ChecksProgress();
  const phase = input.signal ?? new AbortController().signal;
  if (!signalCalls(input.page) && !warned) {
    warned = true;
    console.warn("warning: this Playwright's client is not the one Sandburg knows: a check that runs out of time is not stopped while it waits in a Playwright call");
  }
  await withSignal(phase, () => checksIn(input, progress, phase));
  return progress;
}

async function checksIn(input: ChecksInput, progress: ChecksProgress, phase: AbortSignal): Promise<void> {
  const { page, app } = input;
  const start = app.url();
  const base = new URL('.', start).href;
  const appUrl = (path: string) => new URL(path.replace(/^\/+/, ''), base).href;
  const run = async (check: Planned, fn: () => Promise<{ status: CheckStatus; message?: string; details?: unknown }>, signal = phase) => {
    if (phase.aborted) return null;
    progress.start(check);
    const result = await timed(check, fn, signal);
    progress.finish(check, [result]);
    return result;
  };

  // Every check, in the order they are reported.
  const screenshot = progress.plan('screenshot', 'screenshot', 'Screenshot', false);
  const a11y = progress.plan('a11y-snapshot', 'a11y-snapshot', 'Accessibility tree snapshot', false);
  const axe = progress.plan('axe', 'axe', 'axe-core accessibility scan', false);
  const pageChecks = isPageChecks(input.checks) ? input.checks : null;
  const checksFile = pageChecks && progress.plan('functional:checks-file', 'functional', 'checks file', true);
  const functional = Object.entries(pageChecks ? {} : (input.checks ?? {})).map(([name, fn]) => ({
    name,
    fn,
    check: progress.plan(`functional:${slug(name)}`, 'functional', name, true),
  }));
  const documentCheck = progress.plan('document', 'document', 'The page is not a server error', true);
  const consoleCheck = progress.plan('console', 'console', 'No uncaught errors in the app', true);
  const networkCheck = progress.plan('network', 'network', 'No failed or blocked requests', false);

  // Artifacts first, so they show the app as it first rendered. They only read the page, and so does
  // loading axe-core, which goes on meanwhile (its scan runs after them).
  const axeOrigin = input.hostOrigin && !input.appDocument?.()?.csp ? input.hostOrigin : undefined;
  const axeLoaded = loadAxe(app, axeOrigin, input.axeCode);
  axeLoaded.catch(() => {}); // the axe check reports it
  // Checks that run in the page: their runtime loads meanwhile too.
  const pageChecksLoaded = pageChecks ? loadPageChecksRuntime(page, input.hostOrigin && input.hostOrigin + PAGE_CHECKS_PATH) : undefined;
  pageChecksLoaded?.catch(() => {}); // the checks report it
  // An app that hydrates is waited for meanwhile: a click before it hydrates is lost, and a check
  // that retries it (toPass) waits out its inner assertion's timeout first.
  const settled = input.appSettled?.().catch(() => {});
  await Promise.all([
    run(screenshot, async () => {
      const path = join(input.artifactsDir, 'screenshot.png');
      await page.screenshot({ path });
      progress.artifacts.screenshot = path;
      return { status: 'passed' };
    }),
    run(a11y, async () => {
      const snapshot = await app.locator('body').ariaSnapshot();
      const path = join(input.artifactsDir, 'a11y.yaml');
      await writeFile(path, snapshot + '\n');
      progress.artifacts.a11ySnapshot = path;
      return { status: 'passed', details: { lines: snapshot.split('\n').length } };
    }),
  ]);
  await run(axe, () => runAxe(app, axeLoaded));

  await settled;

  if (checksFile && !phase.aborted) {
    progress.start(checksFile);
    const started = performance.now();
    let results: CheckResult[] | null;
    try {
      results = await runPageChecks(page, pageChecks, { checkTimeoutMs: input.checkTimeoutMs, expectTimeoutMs: input.expectTimeoutMs ?? 5_000 }, pageChecksLoaded);
    } catch (err) {
      // Out of time: the page says which of its checks finished (outside the phase's signal, which has
      // aborted). None, when the file had not loaded yet: then the checks file timed out (close()).
      results = phase.aborted
        ? await withSignal(AbortSignal.timeout(STOP_PAGE_CHECKS_MS), () => stopPageChecks(page, reasonOf(phase))).then((r) => (r.length ? r : null), () => null)
        : [{ ...checkOf(checksFile), durationMs: ms(started), status: 'error', message: stripAnsi(err instanceof Error ? err.message : String(err)) }];
    }
    if (results) progress.finish(checksFile, results);
  }
  for (const { name, fn, check } of functional) {
    const timeout = new AbortController();
    const signal = AbortSignal.any([phase, timeout.signal]);
    let work: Promise<unknown> = Promise.resolve();
    const checkPage = tracked(page);
    const result = await run(
      check,
      async () => {
        const configured = input.expectTimeoutMs ? expect.configure({ timeout: input.expectTimeoutMs }) : expect;
        const checkExpect = stoppable(input.appIdle && input.expectTimeoutMs ? settlingExpect(expect, input.expectTimeoutMs, input.appIdle) : configured, signal);
        const timer = setTimeout(() => timeout.abort(named('TimeoutError', `check "${name}" timed out`)), input.checkTimeoutMs);
        try {
          work = withSignal(signal, () => Promise.resolve().then(() => fn({ app, page: checkPage.page, expect: checkExpect, appUrl, signal })));
          await Promise.race([work, aborted(signal)]);
        } finally {
          clearTimeout(timer);
        }
        return { status: 'passed' };
      },
      signal,
    );
    if (result && timeout.signal.aborted && !phase.aborted) {
      await Promise.race([work.catch(() => {}), sleep(STOP_CHECK_MS, undefined, { ref: false })]);
      await checkPage.remove();
      result.message += await reload(app, start, input.checkTimeoutMs, input.appSettled);
    }
  }

  await run(documentCheck, async () => {
    const doc = input.appDocument?.() ?? null;
    const bad = doc !== null && doc.status >= 500;
    return {
      status: bad ? 'failed' : 'passed',
      message: bad ? `${doc.url} responded with ${doc.status}` : undefined,
      details: doc ? { status: doc.status } : undefined,
    };
  });
  await run(consoleCheck, async () => {
    const errors = input.appErrors();
    const consoleErrors = input.appConsole().filter((c) => c.type === 'error');
    return {
      status: errors.length ? 'failed' : 'passed',
      message: errors.length ? errors.map((e) => e.message).slice(0, 5).join('\n') : undefined,
      details: { uncaught: errors.length, consoleErrors: consoleErrors.length },
    };
  });
  await run(networkCheck, async () => {
    const { failed, blocked } = input.network();
    const bad = failed.length + blocked.length;
    return {
      status: bad ? 'failed' : 'passed',
      message: bad ? [...failed, ...blocked].map((r) => `${r.method} ${r.url}: ${r.reason}`).slice(0, 5).join('\n') : undefined,
      details: { failed: failed.length, blocked: blocked.length },
    };
  });
}

/**
 * A check's page, which notes the route handlers and event listeners the check adds to it, so that
 * those of a check stopped at its timeout can be removed (remove()): they would go on answering and
 * acting beside the next check. Those it adds elsewhere (its page's context) are not noted.
 */
function tracked(page: Page): { page: Page; remove(): Promise<void> } {
  const added: (() => Promise<unknown> | void)[] = [];
  type Fn = (...a: unknown[]) => unknown;
  const proxy: Page = new Proxy(page, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'route') {
        return async (url: Parameters<Page['route']>[0], handler: Parameters<Page['route']>[1], options?: Parameters<Page['route']>[2]) => {
          await target.route(url, handler, options);
          added.push(() => target.unroute(url, handler));
        };
      }
      if (prop === 'on' || prop === 'once' || prop === 'addListener' || prop === 'prependListener') {
        return (event: string, listener: Fn) => {
          (value as Fn).call(target, event, listener);
          added.push(() => void target.off(event as 'load', listener));
          return proxy;
        };
      }
      return (value as Fn).bind(target);
    },
  });
  return {
    page: proxy,
    remove: async () => {
      await Promise.all(added.splice(0).map((undo) => Promise.resolve(undo()).catch(() => {})));
    },
  };
}

/**
 * After a check that timed out: the app loaded again at `url` (where it first loaded), and settled.
 * What the result's message says of it.
 */
async function reload(app: Frame, url: string, timeoutMs: number, settled?: () => Promise<unknown>): Promise<string> {
  try {
    await app.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await settled?.().catch(() => {});
    return '\nThe check was stopped, and the app loaded again before the next check.';
  } catch (err) {
    return `\nThe check was stopped; loading the app again failed: ${stripAnsi(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
  }
}

/**
 * expect(), where a function given to it is no longer called once `signal` aborts (it returns
 * undefined instead), however it is reached: expect(fn), expect.soft(fn), expect.poll(fn), and those
 * of expect.configure(…). toPass retries its function with no deadline of its own: a check stopped in
 * one would otherwise go on retrying for as long as Sandburg runs.
 */
function stoppable(base: typeof expect, signal: AbortSignal): typeof expect {
  type Fn = (...a: unknown[]) => unknown;
  const guard = (value: unknown) => (typeof value === 'function' ? (...a: unknown[]) => (signal.aborted ? undefined : (value as Fn)(...a)) : value);
  const wrap = <T extends object>(fn: T, self: unknown): T =>
    new Proxy(fn, {
      apply: (target, _this, args: unknown[]) => Reflect.apply(target as Fn, self, [guard(args[0]), ...args.slice(1)]),
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'soft' || prop === 'poll') return wrap(value, target);
        if (prop === 'configure') return (...a: unknown[]) => wrap((value as Fn).apply(target, a) as object, undefined);
        return value;
      },
    });
  return wrap(base, undefined);
}

/** A web-first assertion not passed after this long is also checked once every PROBE_EVERY_MS (see settlingExpect). */
const PROBE_AFTER_MS = 250;
const PROBE_EVERY_MS = 100;
/** The timeout of such a check: one try, and one retry at once (Playwright's first two polls). */
const PROBE_TIMEOUT_MS = 1;

/**
 * Web-first assertions that only read the page (toBeVisible, toHaveText, toHaveURL …), on a locator
 * or a page: those that can be checked once beside the assertion. Not toHaveScreenshot (it writes
 * files), and not a function's (toPass runs it).
 */
function probeable(receiver: unknown, matcher: string | symbol): boolean {
  return (
    typeof matcher === 'string' &&
    /^(toBe|toHave|toContain|toMatchAriaSnapshot$)/.test(matcher) &&
    matcher !== 'toHaveScreenshot' &&
    typeof receiver === 'object' &&
    receiver !== null &&
    typeof (receiver as { locator?: unknown }).locator === 'function' &&
    typeof (receiver as { evaluate?: unknown }).evaluate === 'function'
  );
}

/**
 * `outcome`, or sooner: the first of `probe`'s tries, from `afterMs` and every `everyMs` while it is
 * pending, that passes (then `onWin`). A probe that fails changes nothing.
 */
function sooner<T>(outcome: Promise<T>, probe: () => Promise<T>, afterMs: number, everyMs: number, onWin?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      done = true;
      clearTimeout(timer);
    };
    outcome.then(
      (v) => {
        if (!done) resolve(v);
        finish();
      },
      (e) => {
        if (!done) reject(e);
        finish();
      },
    );
    const tick = () => {
      if (done) return;
      probe().then(
        (v) => {
          if (done) return;
          finish();
          onWin?.();
          resolve(v);
        },
        () => {
          if (!done) timer = setTimeout(tick, everyMs);
        },
      );
    };
    timer = setTimeout(tick, afterMs);
  });
}

/** A failing assertion waits at least this long, whatever the app does. */
const SETTLE_FLOOR_MS = 5_000;
/** After the floor, it retries in slices this long, and stops when the app is idle between two. */
const SETTLE_SLICE_MS = 1_000;

/**
 * expect(), with assertions that stop waiting early once nothing can change their outcome.
 *
 * A web-first assertion (toHaveText, toBeVisible, …) retries until its timeout, which must cover a
 * dev server compiling a route on first request. An app that is broken makes every such assertion
 * wait the whole timeout. Here an assertion first waits SETTLE_FLOOR_MS; while it keeps failing it
 * retries in short slices until its timeout, and fails as soon as the app is idle between two slices
 * (`idle(remainingMs)`: the app's servers have no request in flight and are quiet, the page has no
 * timer due within the remaining time and has not changed for a moment; see the session). An
 * assertion with its own `timeout` option, and every other expect() member (poll, soft, …), behave
 * as in Playwright, with the configured timeout.
 *
 * A web-first assertion on a locator or page that has not passed after PROBE_AFTER_MS is also
 * checked once every PROBE_EVERY_MS beside it, and passes when such a check does. Playwright polls
 * every 500 ms after its first ~300 ms: an assertion that waits for a server's answer (a form posted
 * to a dev server compiling its action) saw it up to half a second late. Failures and their messages
 * are the assertion's own.
 */
export function settlingExpect(
  base: typeof expect,
  timeoutMs: number,
  idle: (remainingMs: number) => Promise<boolean>,
  { floorMs = SETTLE_FLOOR_MS, sliceMs = SETTLE_SLICE_MS, probeAfterMs = PROBE_AFTER_MS, probeEveryMs = PROBE_EVERY_MS } = {},
): typeof expect {
  type Chain = Record<string | symbol, unknown>;
  const matchers = (args: unknown[], path: (string | symbol)[], timeout: number): Chain =>
    path.reduce<Chain>((m, p) => m[p] as Chain, (base.configure({ timeout }) as unknown as (...a: unknown[]) => Chain)(...args));
  // stopped(): a probe passed (sooner), so no further attempt starts; the one in flight ends on its own timeout.
  const settle = async (first: Promise<unknown>, again: (timeout: number) => unknown, stopped = () => false): Promise<unknown> => {
    const start = performance.now();
    let attempt = first;
    for (;;) {
      try {
        return await attempt;
      } catch (err) {
        const left = timeoutMs - (performance.now() - start);
        const timedOut = !!(err as { matcherResult?: { timeout?: number } }).matcherResult?.timeout;
        if (!timedOut || left < 100 || stopped()) throw err;
        if (await idle(left).catch(() => false)) {
          const waited = ((performance.now() - start) / 1000).toFixed(1);
          if (err instanceof Error) err.message += `\n\nStopped waiting after ${waited} s of ${timeoutMs / 1000} s: the app was idle (no request in flight, no timer due, no change to the page).`;
          throw err;
        }
        attempt = again(Math.min(sliceMs, left)) as Promise<unknown>;
      }
    }
  };
  const chain = (args: unknown[], path: (string | symbol)[]): Chain =>
    new Proxy(matchers(args, path, timeoutMs), {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === 'not' || prop === 'resolves' || prop === 'rejects') return chain(args, [...path, prop]);
        if (typeof value !== 'function') return value;
        return (...margs: unknown[]) => {
          const own = margs.some((a) => typeof a === 'object' && a !== null && 'timeout' in a);
          const call = (timeout: number) => (matchers(args, path, timeout)[prop] as (...a: unknown[]) => unknown)(...margs);
          const first = call(own ? timeoutMs : Math.min(floorMs, timeoutMs));
          if (typeof (first as { then?: unknown } | null)?.then !== 'function') return first;
          let won = false;
          const outcome = own ? (first as Promise<unknown>) : settle(first as Promise<unknown>, call, () => won);
          if (!probeable(args[0], prop)) return outcome;
          // A one-shot check of the same assertion (its own timeout, if it has one, replaced).
          const probe = () =>
            (matchers(args, path, PROBE_TIMEOUT_MS)[prop] as (...a: unknown[]) => Promise<unknown>)(
              ...margs.map((a) => (typeof a === 'object' && a !== null && 'timeout' in a ? { ...a, timeout: PROBE_TIMEOUT_MS } : a)),
            );
          return sooner(outcome, probe, probeAfterMs, probeEveryMs, () => (won = true));
        };
      },
    });
  // Members (poll, soft, …) come from an expect with the configured timeout.
  return new Proxy(base.configure({ timeout: timeoutMs }), {
    apply: (_target, _this, args: unknown[]) => chain(args, []),
  });
}

const require = createRequire(import.meta.url);
let axeSource: Promise<string> | null = null;

/**
 * Loads axe-core into the app's frame: from the app's origin where it serves it (the host's origin),
 * with its compiled code if the session has it (a classic script, which then compiles nothing), else
 * imported (the browser streams and compiles the 650 KB script off the main thread, while the
 * artifacts are taken); else evaluated in the frame: when the app's document has a
 * Content-Security-Policy (which may refuse the script, and log that in the app's console), or the
 * script fails to load.
 */
async function loadAxe(app: Frame, origin?: string, code?: PageCode): Promise<void> {
  const own = !!origin && URL.canParse(app.url()) && new URL(app.url()).origin === origin;
  const csp = () => app.evaluate(() => !!document.querySelector('meta[http-equiv="content-security-policy" i]')).catch(() => true);
  const defined = () => app.evaluate(() => typeof window.axe === 'object').catch(() => false);
  if (own && code && !(await csp())) {
    const loaded = await code.load(app);
    void code.close(); // the code is for this load only
    if (loaded && (await defined())) return;
  }
  const imported =
    own &&
    (await app
      .evaluate(
        (u) =>
          !document.querySelector('meta[http-equiv="content-security-policy" i]') &&
          import(u).then(() => typeof window.axe === 'object'),
        origin + AXE_PATH,
      )
      .catch(() => false));
  if (imported) return;
  axeSource ??= readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  await app.evaluate(await axeSource);
}

async function runAxe(app: Frame, loaded: Promise<void>): Promise<{ status: CheckStatus; message?: string; details?: unknown }> {
  await loaded;
  const summary = await app.evaluate(async () => {
    const axe = window.axe!;
    const { violations } = await axe.run(document, { resultTypes: ['violations'] });
    return violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  });
  return {
    status: summary.length ? 'failed' : 'passed',
    message: summary.length ? summary.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes)`).join(', ') : undefined,
    details: { violations: summary },
  };
}

/** A planned check's id, kind, name and blocking. */
function checkOf({ id, kind, name, blocking }: Planned): Pick<CheckResult, 'id' | 'kind' | 'name' | 'blocking'> {
  return { id, kind, name, blocking };
}

/** Runs a check: its result, and how long it took. When `signal` aborted, the check was stopped (it failed). */
async function timed(check: Planned, fn: () => Promise<{ status: CheckStatus; message?: string; details?: unknown }>, signal?: AbortSignal): Promise<CheckResult> {
  const start = performance.now();
  try {
    const out = await fn();
    return { ...checkOf(check), durationMs: ms(start), ...out };
  } catch (err) {
    if (signal?.aborted) {
      // Its own timeout says so; the phase's deadline ("checks did not finish within …") is said to be one.
      const reason = stripAnsi(reasonOf(signal));
      return { ...checkOf(check), durationMs: ms(start), status: 'failed', message: /timed out/.test(reason) ? reason : `timed out: ${reason}` };
    }
    // Assertions and locator timeouts mean the app misbehaved: the check failed.
    // Anything else (a TypeError in the check, a bad import) is an error in the check itself.
    const isAssertion =
      err instanceof Error &&
      ('matcherResult' in err || ['AssertionError', 'TimeoutError'].includes(err.name) || /timed out/i.test(err.message));
    return {
      ...checkOf(check),
      durationMs: ms(start),
      status: isAssertion ? 'failed' : 'error',
      message: stripAnsi(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** Rejects with the signal's reason once it aborts. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function reasonOf(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
