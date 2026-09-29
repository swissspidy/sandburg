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

export interface CheckContext {
  /** The app frame. Locators, getByRole etc. work as on a page. */
  app: Frame;
  /** The sandbox tab (host page). Prefer `app` for interacting with the app. */
  page: Page;
  expect: typeof expect;
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
  checks: Checks | null;
  checkTimeoutMs: number;
  artifactsDir: string;
  /** Read at the end so errors raised during functional checks count. */
  appErrors: () => PageError[];
  appConsole: () => ConsoleEntry[];
  network: () => { failed: NetworkEntry[]; blocked: NetworkEntry[] };
}

export interface ChecksOutput {
  checks: CheckResult[];
  artifacts: { screenshot?: string; a11ySnapshot?: string };
}

export async function runChecks(input: ChecksInput): Promise<ChecksOutput> {
  const results: CheckResult[] = [];
  const artifacts: ChecksOutput['artifacts'] = {};
  const { page, app } = input;

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

  for (const [name, fn] of Object.entries(input.checks ?? {})) {
    results.push(
      await timed(`functional:${slug(name)}`, 'functional', name, true, async () => {
        await withTimeout(Promise.resolve(fn({ app, page, expect })), input.checkTimeoutMs, `check "${name}" timed out`);
        return { status: 'passed' };
      }),
    );
  }

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
