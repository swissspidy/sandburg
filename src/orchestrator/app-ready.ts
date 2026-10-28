/**
 * When the app is ready (the ready phase): its frame rendered something, past a dev server's loading
 * and error pages; and when to stop waiting early, because the app threw or a runtime asset failed.
 */
import type { Frame, Page } from 'playwright-core';
import type { ConsoleEntry } from '../types.ts';
import { RunState } from './run-state.ts';
import { appRendered } from '../host/rendered.ts';
import { describeFinding, type SourceFinding } from '../source-check.ts';
import type { ProjectReads } from '../host/types.ts';
import { SOURCE_STALL } from '../classify.ts';

/** Grace period after a runtime asset fails before the phase gives up (the runtime may retry). */
const RUNTIME_FETCH_GRACE_MS = 3_000;

/**
 * Rejects when one of the runtime's own assets (an allowlisted origin) fails to
 * load in the browser, so a flaky download fails the phase quickly as infra
 * instead of waiting out its deadline.
 */
export async function failFastOnRuntimeFetch<T>(work: Promise<T>, run: RunState, allow: (origin: string) => boolean): Promise<T> {
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

/** The frame the app renders in: the host's #app iframe. */
export async function appFrame(page: Page): Promise<Frame> {
  const frame = await (await page.waitForSelector('#app')).contentFrame();
  if (!frame) throw new Error('app frame is not attached');
  return frame;
}

/**
 * Adapter-agnostic readiness: the app rendered something visible (host/rendered.ts). Two pages are not the app yet:
 * the browser's own error page ("refused to connect"), when a dev server takes its port before it
 * can answer (Nuxt 4.6 does), and a dev server's loading page: Nuxt's, marked __NUXT_LOADING__,
 * which reloads itself once the app is built, or any 503 answer (`loading`). The app is loaded
 * again until it renders or the phase's deadline passes. `rendered` asks the host page first (one call,
 * where Playwright's waitForFunction first sets itself up in the new frame), if there is one.
 */
export async function waitForRender(frame: Frame, selector?: string, reload?: () => Promise<unknown>, loading?: () => boolean, rendered?: () => Promise<boolean>): Promise<void> {
  if (rendered && (await rendered().catch(() => false)) && !loading?.()) return;
  for (let tries = 1; ; tries++) {
    // The run ended (the phase timed out and the tab closed): stop trying.
    if (frame.isDetached() || frame.page().isClosed()) throw new Error('the app frame is gone');
    const state = await frame
      .waitForFunction(`(${appRendered.toString()})(document, ${JSON.stringify(selector ?? null)})`, undefined, { polling: 100, timeout: RELOAD_ERROR_PAGE_MS })
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

/** Chromium's console error for a request, a document's included, that answered a server error. */
const FAILED_LOAD_5XX = /Failed to load resource: the server responded with a status of 5\d\d\b/;

/**
 * Rejects if the app throws (or logs a console error) and still has not
 * rendered after a grace period, so a broken app fails `ready` with its own
 * error instead of timing out. A module that 404s, for example, fails
 * silently except for a console error. So does a page that still answers a
 * server error (other than a loading page's 503) after that grace period:
 * `frame`'s documents, else those not the host page's.
 */
export async function failFastOnAppError(render: Promise<void>, run: RunState, loadingPage?: () => Promise<boolean>, frame?: Frame): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // What a dev server's loading page logs (Nuxt answers 503 while it builds) is not the app's.
  let seenErrors = 0;
  let seenConsole = 0;
  let done = false;
  const watch = new Promise<never>((_, reject) => {
    let deadline = 0;
    let reason = '';
    /** For a deadline set on the page's answer: whether the page still answers a server error (it may have recovered). */
    let still: (() => boolean) | null = null;
    /** When each of the app's errors was first seen (looked for while a page's server error waits to be checked again too). */
    const firstSeen = new Map<object, number>();
    // The app's page: its frame's documents (not the host page's, nor those of frames the app embeds).
    const pageDocuments = () => (frame ? run.documents.filter((d) => d.frame === frame) : run.documents.filter((d) => !d.url.includes('/__sandburg/')));
    const pageDocument = () => pageDocuments().at(-1);
    const serverError = () => {
      const page = pageDocument();
      return page && page.status >= 500 && page.status !== 503 ? page : null;
    };
    const poll = async () => {
      if (!deadline && loadingPage && (await loadingPage())) [seenErrors, seenConsole] = [run.pageErrors.length, run.console.length];
      if (done) return;
      // While a page's server error waits to be checked again, the app's own errors are still looked
      // for: if the page has recovered by then, they fail the phase in their own time (below).
      if (!deadline || still) {
        const errs = run.pageErrors.slice(seenErrors).filter((e) => e.source === 'app');
        // The page's own 503 is a dev server still loading (see waitForRender), not the app failing. A
        // later error for the same page is not: Nuxt answers 503 while it builds, then 500 for a page
        // it cannot render (and that error page refuses to be framed, so the frame shows the browser's).
        const loading503 = (c: ConsoleEntry) => !!c.url && /\b503\b/.test(c.text) && run.documents.some((d) => d.status === 503 && d.url === c.url);
        // The browser's report of one of the page's own server errors ("Failed to load resource: … status
        // of 500") is the server-error rule's below, which checks again whether the page has recovered.
        // Each of the page's 5xx loads accounts for one such report for its URL, in order: a later one is
        // the app's own request to that URL failing (a POST from a server action, htmx or Turbo).
        const pageLoad = (c: ConsoleEntry) => {
          if (!c.url || !FAILED_LOAD_5XX.test(c.text)) return false;
          const loads = pageDocuments().filter((d) => d.url === c.url && d.status >= 500).length;
          // The page's own reports only (the host page's, for the same URL, are not about the app's frame).
          const upTo = run.console.slice(0, run.console.indexOf(c) + 1).filter((e) => e.source === 'app' && e.url === c.url && FAILED_LOAD_5XX.test(e.text)).length;
          return upTo <= loads;
        };
        const logs = run.console.slice(seenConsole).filter((c) => c.source === 'app' && c.type === 'error' && !BENIGN_CONSOLE.test(`${c.text} ${c.url ?? ''}`) && !loading503(c) && !pageLoad(c));
        const now = Date.now();
        for (const e of [...errs, ...logs]) if (!firstSeen.has(e)) firstSeen.set(e, now);
        if (!deadline) {
          // An error first seen after the page's latest document came keeps that time (the app's POST to
          // its page, after a cold start's 500 and then a 200); one from before (the error page's own)
          // has its grace from now, as the page is another one now.
          const pageAt = pageDocument()?.at;
          const since = (e: object) => {
            const seen = firstSeen.get(e)!;
            return pageAt !== undefined && seen >= pageAt ? seen : now;
          };
          const failing = [
            ...errs.map((e): [number, string] => [since(e) + RENDER_GRACE_MS, `app threw before rendering: ${e.message}`]),
            ...logs.map((c): [number, string] => [since(c) + CONSOLE_GRACE_MS, `app did not render after a console error: ${c.text}${c.url ? ` (${c.url})` : ''}`]),
          ].sort((a, b) => a[0] - b[0])[0];
          // The app's page itself answered a server error (not a dev server's 503 loading page).
          const page = serverError();
          if (failing) [deadline, reason] = failing;
          else if (page) [deadline, reason, still] = [now + CONSOLE_GRACE_MS, `app did not render: its page answered HTTP ${page.status} (${page.url})`, () => !!serverError()];
        }
      }
      if (deadline && Date.now() >= deadline) {
        // A server error the page has since recovered from (a cold start's 500, then a 200) is not the app failing.
        if (still && !still()) [deadline, still] = [0, null];
        else {
          reject(new Error(reason));
          return;
        }
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

/** How long the ready phase waits for the app before it checks the project's sources (failOnSourceStall). */
const SOURCE_CHECK_AFTER_MS = 20_000;

/** How long the dev server and the page must have been quiet before what the source check found fails the phase. */
const SOURCE_QUIET_MS = 10_000;

/** Whether a console entry says the app is still getting somewhere: the runtime's output, or the page's error (the app-error watch's to judge). */
const active = (c: ConsoleEntry) => (c.source === 'host' && c.text.startsWith('[runtime:')) || (c.source === 'app' && c.type === 'error');

/**
 * Whether the app's page hangs (`docs`: its frame's documents, in order): its latest answered 2xx and
 * has streamed for at least SOURCE_QUIET_MS without ending (SolidStart's on a fault). Not a page
 * not answered yet (compiling), nor one that just came and is still being read, nor an error page.
 */
export function pageHangs(docs: { status: number; ended?: boolean; at?: number }[], now = Date.now()): boolean {
  const doc = docs.at(-1);
  return !!doc && doc.status >= 200 && doc.status < 300 && doc.ended === false && doc.at !== undefined && now - doc.at >= SOURCE_QUIET_MS;
}

/** How often what the source check found is matched again with what the app's processes have read (failOnSourceStall). */
const SOURCE_RELEVANCE_MS = 2_000;

/**
 * What the source check found that bears on the running app (`answer`, from its runtime): a finding
 * in a file the app's processes have read (a file only another route imports was not), and of an
 * undeclared import, only one whose package is not installed where the file imports it from (npm
 * hoists what dependencies need: Nuxt's h3, a Next app's @tanstack/query-core). Nothing, when the
 * runtime does not record what it read. `answer.installed` is in the order of the undeclared imports.
 */
export function relevantFindings(found: SourceFinding[], answer: ProjectReads | null): SourceFinding[] {
  if (!answer?.reads) return [];
  const read = new Set(answer.reads);
  let i = 0;
  return found.filter((f) => {
    const installed = f.rule === 'undeclared-import' ? answer.installed[i++] : false;
    return read.has(f.file) && !installed;
  });
}

/**
 * Rejects when the app has not rendered after 20 s, its sources have a syntax error or import a
 * package it does not declare (`check`, source-check.ts) in a file its processes have read
 * (`relevant`, relevantFindings), and the page hangs: its document answered 2xx and is still
 * streaming (`hanging`: not a loading page), and its dev server and page have said nothing for 10 s.
 * Some dev servers report neither fault and hang so (SolidStart 2.1.0 streams the page and never
 * ends it). An app whose page has not been answered yet is compiling (`next dev` says so once, then
 * nothing until it answers), and a page that streams slowly has read no broken file: they run to the
 * phase's deadline, and what was found classifies a timeout. The sources are checked once, at 20 s,
 * so a run whose app renders sooner never pays for it; what bears on the app is kept for
 * classification (`run.sourceFindings`), matched again every 2 s. `signal` stops the watch.
 */
export async function failOnSourceStall(
  render: Promise<void>,
  run: RunState,
  check: () => Promise<SourceFinding[]>,
  hanging: () => Promise<boolean>,
  relevant: (found: SourceFinding[]) => Promise<SourceFinding[]> = async (found) => found,
  signal?: AbortSignal,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  // The phase ended otherwise (the app-error watch failed it): stop watching.
  signal?.addEventListener(
    'abort',
    () => {
      done = true;
      clearTimeout(timer);
    },
    { once: true },
  );
  const watch = new Promise<never>((_, reject) => {
    const start = Date.now();
    let quietSince = start;
    let [consoleSeen, errorsSeen] = [run.console.length, run.pageErrors.length];
    let checked = false;
    /** What the check found (null until it is done), and when it was last matched with what the app read. */
    let found: SourceFinding[] | null = null;
    let matchedAt = 0;
    const poll = async () => {
      if (done) return;
      const now = Date.now();
      if (run.pageErrors.length > errorsSeen || run.console.slice(consoleSeen).some(active)) quietSince = now;
      [consoleSeen, errorsSeen] = [run.console.length, run.pageErrors.length];
      if (!checked && now - start >= SOURCE_CHECK_AFTER_MS) {
        checked = true;
        void check().then(
          (f) => void (found = f),
          () => void (found = []),
        );
      }
      if (found && (found.length || !run.sourceFindings) && now - matchedAt >= SOURCE_RELEVANCE_MS) {
        matchedAt = now;
        run.sourceFindings = found.length ? await relevant(found).catch(() => []) : [];
        if (done) return;
      }
      const first = run.sourceFindings?.[0];
      if (first && Date.now() - quietSince >= SOURCE_QUIET_MS && (await hanging().catch(() => false)) && !done) {
        reject(new Error(`${SOURCE_STALL}${describeFinding(first)}`));
        return;
      }
      if (!done) timer = setTimeout(() => void poll(), 200);
    };
    void poll();
  });
  try {
    await Promise.race([render, watch]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}
