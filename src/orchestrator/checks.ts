/**
 * Checks run in the sandbox tab against the app frame: user functional checks
 * plus built-in console, network, axe, accessibility-snapshot and screenshot.
 */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import type { Frame, Page } from 'playwright-core';
import type { CheckKind, CheckResult, CheckStatus, ConsoleEntry, NetworkEntry, PageError } from '../types.ts';
import { isPageChecks, runPageChecks, type PageChecks } from '../page-checks/index.ts';

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
}

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
  appDocument?: () => { url: string; status: number } | null;
}

export interface ChecksOutput {
  checks: CheckResult[];
  artifacts: { screenshot?: string; a11ySnapshot?: string };
}

export async function runChecks(input: ChecksInput): Promise<ChecksOutput> {
  const results: CheckResult[] = [];
  const artifacts: ChecksOutput['artifacts'] = {};
  const { page, app } = input;
  const base = new URL('.', app.url()).href;
  const appUrl = (path: string) => new URL(path.replace(/^\/+/, ''), base).href;

  // Artifacts first, so they show the app as it first rendered.
  results.push(
    await timed('screenshot', 'screenshot', 'Screenshot', false, async () => {
      artifacts.screenshot = join(input.artifactsDir, 'screenshot.png');
      await page.screenshot({ path: artifacts.screenshot });
      return { status: 'passed' };
    }),
  );
  results.push(
    await timed('a11y-snapshot', 'a11y-snapshot', 'Accessibility tree snapshot', false, async () => {
      const snapshot = await app.locator('body').ariaSnapshot();
      artifacts.a11ySnapshot = join(input.artifactsDir, 'a11y.yaml');
      await writeFile(artifacts.a11ySnapshot, snapshot + '\n');
      return { status: 'passed', details: { lines: snapshot.split('\n').length } };
    }),
  );
  results.push(await timed('axe', 'axe', 'axe-core accessibility scan', false, () => runAxe(app)));

  if (isPageChecks(input.checks)) {
    const started = performance.now();
    try {
      results.push(...(await runPageChecks(page, input.checks, { checkTimeoutMs: input.checkTimeoutMs, expectTimeoutMs: input.expectTimeoutMs ?? 5_000 })));
    } catch (err) {
      results.push({
        id: 'functional:checks-file',
        kind: 'functional',
        name: 'checks file',
        blocking: true,
        durationMs: ms(started),
        status: 'error',
        message: stripAnsi(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  for (const [name, fn] of Object.entries(isPageChecks(input.checks) ? {} : (input.checks ?? {}))) {
    results.push(
      await timed(`functional:${slug(name)}`, 'functional', name, true, async () => {
        const configured = input.expectTimeoutMs ? expect.configure({ timeout: input.expectTimeoutMs }) : expect;
        const checkExpect = input.appIdle && input.expectTimeoutMs ? settlingExpect(expect, input.expectTimeoutMs, input.appIdle) : configured;
        await withTimeout(Promise.resolve(fn({ app, page, expect: checkExpect, appUrl })), input.checkTimeoutMs, `check "${name}" timed out`);
        return { status: 'passed' };
      }),
    );
  }

  results.push(
    await timed('document', 'document', 'The page is not a server error', true, async () => {
      const doc = input.appDocument?.() ?? null;
      const bad = doc !== null && doc.status >= 500;
      return {
        status: bad ? 'failed' : 'passed',
        message: bad ? `${doc.url} responded with ${doc.status}` : undefined,
        details: doc ? { status: doc.status } : undefined,
      };
    }),
  );
  results.push(
    await timed('console', 'console', 'No uncaught errors in the app', true, async () => {
      const errors = input.appErrors();
      const consoleErrors = input.appConsole().filter((c) => c.type === 'error');
      return {
        status: errors.length ? 'failed' : 'passed',
        message: errors.length ? errors.map((e) => e.message).slice(0, 5).join('\n') : undefined,
        details: { uncaught: errors.length, consoleErrors: consoleErrors.length },
      };
    }),
  );
  results.push(
    await timed('network', 'network', 'No failed or blocked requests', false, async () => {
      const { failed, blocked } = input.network();
      const bad = failed.length + blocked.length;
      return {
        status: bad ? 'failed' : 'passed',
        message: bad ? [...failed, ...blocked].map((r) => `${r.method} ${r.url}: ${r.reason}`).slice(0, 5).join('\n') : undefined,
        details: { failed: failed.length, blocked: blocked.length },
      };
    }),
  );
  return { checks: results, artifacts };
}

/** A failing assertion waits at least this long, whatever the app does. */
export const SETTLE_FLOOR_MS = 5_000;
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
 */
export function settlingExpect(
  base: typeof expect,
  timeoutMs: number,
  idle: (remainingMs: number) => Promise<boolean>,
  { floorMs = SETTLE_FLOOR_MS, sliceMs = SETTLE_SLICE_MS } = {},
): typeof expect {
  type Chain = Record<string | symbol, unknown>;
  const matchers = (args: unknown[], path: (string | symbol)[], timeout: number): Chain =>
    path.reduce<Chain>((m, p) => m[p] as Chain, (base.configure({ timeout }) as unknown as (...a: unknown[]) => Chain)(...args));
  const settle = async (first: Promise<unknown>, again: (timeout: number) => unknown): Promise<unknown> => {
    const start = performance.now();
    let attempt = first;
    for (;;) {
      try {
        return await attempt;
      } catch (err) {
        const left = timeoutMs - (performance.now() - start);
        const timedOut = !!(err as { matcherResult?: { timeout?: number } }).matcherResult?.timeout;
        if (!timedOut || left < 100) throw err;
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
          return own || typeof (first as { then?: unknown } | null)?.then !== 'function' ? first : settle(first as Promise<unknown>, call);
        };
      },
    });
  // Members (poll, soft, …) come from an expect with the configured timeout.
  return new Proxy(base.configure({ timeout: timeoutMs }), {
    apply: (_target, _this, args: unknown[]) => chain(args, []),
  }) as typeof expect;
}

const require = createRequire(import.meta.url);
let axeSource: Promise<string> | null = null;

async function runAxe(app: Frame): Promise<{ status: CheckStatus; message?: string; details?: unknown }> {
  axeSource ??= readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  await app.evaluate(await axeSource);
  const summary = await app.evaluate(async () => {
    const axe = (window as unknown as { axe: { run(ctx: Document, opts: object): Promise<{ violations: { id: string; impact: string | null; nodes: unknown[] }[] }> } }).axe;
    const { violations } = await axe.run(document, { resultTypes: ['violations'] });
    return violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  });
  return {
    status: summary.length ? 'failed' : 'passed',
    message: summary.length ? summary.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes)`).join(', ') : undefined,
    details: { violations: summary },
  };
}

async function timed(
  id: string,
  kind: CheckKind,
  name: string,
  blocking: boolean,
  fn: () => Promise<{ status: CheckStatus; message?: string; details?: unknown }>,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const out = await fn();
    return { id, kind, name, blocking, durationMs: ms(start), ...out };
  } catch (err) {
    // Assertions and locator timeouts mean the app misbehaved: the check failed.
    // Anything else (a TypeError in the check, a bad import) is an error in the check itself.
    const isAssertion =
      err instanceof Error &&
      ('matcherResult' in err || ['AssertionError', 'TimeoutError'].includes(err.name) || /timed out/i.test(err.message));
    return {
      id,
      kind,
      name,
      blocking,
      durationMs: ms(start),
      status: isAssertion ? 'failed' : 'error',
      message: stripAnsi(err instanceof Error ? err.message : String(err)),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
