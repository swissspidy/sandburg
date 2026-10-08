/**
 * Checks that run in the page (`--checks-in page`, ADR 0023): the checks file's code runs in the
 * sandbox tab (page-checks/runtime.ts), not in this process. Here the file is only read and its
 * TypeScript types stripped: esbuild's transform parses one file, it does not resolve its imports or
 * read others, and nothing of it runs here. What comes back from the page is data, checked as such.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import * as esbuild from 'esbuild';
import type { Page } from 'playwright-core';
import { source } from '../sources.ts';
import type { CheckResult } from '../types.ts';
import type { PageChecksOptions, PageChecksOutput } from './types.ts';

/** A checks file to run in the page: its code as JavaScript (an ES module). */
export interface PageChecks {
  kind: 'page';
  file: string;
  code: string;
}

export const isPageChecks = (checks: unknown): checks is PageChecks =>
  !!checks && typeof checks === 'object' && (checks as { kind?: unknown }).kind === 'page';

const LOADERS: Record<string, esbuild.Loader> = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx' };

export async function loadPageChecks(file: string): Promise<PageChecks> {
  const text = await readFile(file, 'utf8');
  const { code } = await esbuild.transform(text, {
    loader: LOADERS[extname(file)] ?? 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: file,
  });
  return { kind: 'page', file, code };
}

let bundle: Promise<string> | null = null;
/** The page's runtime: page-checks/runtime.ts with ivya and user-event, as one script. */
function runtimeBundle(): Promise<string> {
  bundle ??= esbuild
    .build({
      entryPoints: [source('page-checks/runtime.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      alias: { '@testing-library/dom': source('page-checks/dom-shim.ts') },
    })
    .then((r) => r.outputFiles[0].text);
  return bundle;
}

const MAX_MESSAGE = 8_000;

/** Runs the checks in the sandbox tab, against its app frame (#app). */
export async function runPageChecks(page: Page, checks: PageChecks, options: PageChecksOptions): Promise<CheckResult[]> {
  const main = page.mainFrame();
  if (!(await main.evaluate(() => !!window.__sandburgPageChecks))) await main.addScriptTag({ content: await runtimeBundle() });
  const out = (await main.evaluate(([code, opts]) => window.__sandburgPageChecks!.run(code, opts), [checks.code, options] as const)) as unknown;
  if (!out || typeof out !== 'object') throw new Error('page checks: no result from the page');
  if ('error' in out) {
    return [{ id: 'functional:checks-file', kind: 'functional', name: 'checks file', blocking: true, durationMs: 0, status: 'error', message: String((out as { error: unknown }).error).slice(0, MAX_MESSAGE) }];
  }
  const results = (out as PageChecksOutput & { results: unknown }).results;
  if (!Array.isArray(results)) throw new Error('page checks: malformed result from the page');
  return results.map((r: Record<string, unknown>, i) => {
    const name = typeof r.name === 'string' ? r.name.slice(0, 500) : `check ${i + 1}`;
    const status = r.status === 'passed' || r.status === 'failed' ? r.status : 'error';
    return {
      id: `functional:${slug(name)}`,
      kind: 'functional',
      name,
      blocking: true,
      durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? Math.max(0, Math.round(r.durationMs)) : 0,
      status,
      message: typeof r.message === 'string' ? r.message.slice(0, MAX_MESSAGE) : undefined,
    };
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
