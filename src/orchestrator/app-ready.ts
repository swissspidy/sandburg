/**
 * When the app is ready (the ready phase): its frame rendered something, past a dev server's loading
 * and error pages; and when to stop waiting early, because the app threw or a runtime asset failed.
 */
import type { Frame, Page } from 'playwright-core';
import type { ConsoleEntry } from '../types.ts';
import { RunState } from './run-state.ts';
import { appRendered } from '../host/rendered.ts';

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
      if (!deadline) {
        const err = run.pageErrors.slice(seenErrors).find((e) => e.source === 'app');
        // The page's own 503 is a dev server still loading (see waitForRender), not the app failing. A
        // later error for the same page is not: Nuxt answers 503 while it builds, then 500 for a page
        // it cannot render (and that error page refuses to be framed, so the frame shows the browser's).
        const loading503 = (c: ConsoleEntry) => !!c.url && /\b503\b/.test(c.text) && run.documents.some((d) => d.status === 503 && d.url === c.url);
        // The browser's report of one of the page's own server errors ("Failed to load resource: … status
        // of 500") is the server-error rule's below, which checks again whether the page has recovered.
        const pageLoad = (c: ConsoleEntry) => /Failed to load resource: the server responded with a status of 5\d\d\b/.test(c.text) && pageDocuments().some((d) => d.url === c.url && d.status >= 500);
        const logged = run.console.slice(seenConsole).find((c) => c.source === 'app' && c.type === 'error' && !BENIGN_CONSOLE.test(`${c.text} ${c.url ?? ''}`) && !loading503(c) && !pageLoad(c));
        // The app's page itself answered a server error (not a dev server's 503 loading page).
        const page = serverError();
        if (err) [deadline, reason] = [Date.now() + RENDER_GRACE_MS, `app threw before rendering: ${err.message}`];
        else if (logged) [deadline, reason] = [Date.now() + CONSOLE_GRACE_MS, `app did not render after a console error: ${logged.text}${logged.url ? ` (${logged.url})` : ''}`];
        else if (page) [deadline, reason, still] = [Date.now() + CONSOLE_GRACE_MS, `app did not render: its page answered HTTP ${page.status} (${page.url})`, () => !!serverError()];
      } else if (Date.now() >= deadline) {
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
