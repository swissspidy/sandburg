/**
 * V8's compiled code for the host's own scripts, kept across runs (ADR 0042).
 *
 * Every run is its own browser context, an off-the-record profile with no code cache, so the 650 KB
 * of axe-core that the checks load into the app's frame was compiled anew in every run: its compile
 * and the lazy compiles of its first scan, ~60 ms of the app's main thread. DevTools can hand a page
 * compiled code for a classic script by its URL (Page.addCompilationCache), and produce it
 * (Page.produceCompilationCache, eagerly: every function compiled). Chromium consults it only for
 * a script it does not stream, so the host serves such a script in an encoding Chromium does not
 * stream (UTF-16, CLASSIC_CHARSET).
 *
 * - The code is produced from the host's own copy of the script, in a browser context of its own
 *   that loads nothing else (no sandbox, no app), and is keyed by a digest of the script's text, the
 *   browser's version and its V8 flags. Nothing a run does reaches it.
 * - A run gets a copy (DevTools sends it to its page); V8 checks it against the browser's version,
 *   flags and the script's length, and compiles the script as usual if it does not fit.
 * - On disk (.sandburg/code-cache), each entry carries a digest of its bytes, checked on read: a
 *   damaged entry is produced again.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser, CDPSession, Frame, Page } from 'playwright-core';

/** A host script that a run loads into its pages, the same text in every run. */
export interface HostScript {
  /** Its name in cache entries. */
  name: string;
  source(): Promise<string>;
}

/** The charset the host serves a cacheable script in: one Chromium does not stream (see above). */
export const CLASSIC_CHARSET = 'utf-16le';
/** A cacheable script's body as the host serves it. */
export const classicBody = (source: string): Buffer => Buffer.from(source, CLASSIC_CHARSET);

/** Where the code is produced: a page of its own, answered by the context's routes (no network). */
const PRODUCER_ORIGIN = 'http://code-cache.sandburg.invalid';
const PRODUCE_TIMEOUT_MS = 15_000;
const DIGEST_BYTES = 32;

export class CodeCache {
  private entries = new Map<string, Promise<string | null>>();
  private browser: Browser;
  private salt: string;
  private dir: string | null;

  /**
   * @param browser where code is produced (the session's browser: the code fits its V8)
   * @param salt what else the code depends on (the browser's launch flags)
   * @param dir where entries are kept across sessions, or null for memory only
   */
  constructor(browser: Browser, salt: string, dir: string | null) {
    this.browser = browser;
    this.salt = salt;
    this.dir = dir;
  }

  /** The script's code (base64, as DevTools takes it), read or produced once. Never rejects: a failure means no code. */
  prepare(script: HostScript): Promise<string | null> {
    let entry = this.entries.get(script.name);
    if (!entry) {
      entry = this.load(script).catch(() => null);
      this.entries.set(script.name, entry);
    }
    return entry;
  }

  /** Gives a page the script's code for `url`, once it is ready (see PageCode). */
  attach(page: Page, script: HostScript, url: string): PageCode {
    return new PageCode(page, url, this.prepare(script));
  }

  private async load(script: HostScript): Promise<string | null> {
    const source = await script.source();
    const key = createHash('sha256').update(`${this.browser.version()}\0${this.salt}\0`).update(source).digest('hex');
    const file = this.dir && join(this.dir, `${script.name}-${key}.bin`);
    if (file) {
      const stored = await readFile(file).catch(() => null);
      if (stored && stored.length > DIGEST_BYTES && createHash('sha256').update(stored.subarray(DIGEST_BYTES)).digest().equals(stored.subarray(0, DIGEST_BYTES))) {
        return stored.subarray(DIGEST_BYTES).toString('base64');
      }
    }
    const data = await produce(this.browser, source);
    if (data && file) {
      const bytes = Buffer.from(data, 'base64');
      const tmp = `${file}.${process.pid}.tmp`;
      await mkdir(dirname(file), { recursive: true })
        .then(() => writeFile(tmp, Buffer.concat([createHash('sha256').update(bytes).digest(), bytes])))
        .then(() => rename(tmp, file))
        // The script's entries for other browsers, flags or versions of it go.
        .then(() => readdir(this.dir!))
        .then((names) => Promise.all(names.filter((n) => n.startsWith(`${script.name}-`) && n.endsWith('.bin') && join(this.dir!, n) !== file).map((n) => rm(join(this.dir!, n), { force: true }))))
        .catch(() => {}); // not kept (a read-only directory): produced again by the next session
    }
    return data;
  }
}

/** Compiles the script eagerly in a context of its own and returns V8's code cache for it (base64). */
async function produce(browser: Browser, source: string): Promise<string | null> {
  const context = await browser.newContext();
  let timer: NodeJS.Timeout | undefined;
  try {
    const url = `${PRODUCER_ORIGIN}/script.js`;
    await context.route('**/*', (route) =>
      route.request().url() === url
        ? route.fulfill({ status: 200, contentType: `text/javascript; charset=${CLASSIC_CHARSET}`, body: classicBody(source) })
        : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>code cache</title>' }),
    );
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    await page.goto(`${PRODUCER_ORIGIN}/`);
    const produced = new Promise<string | null>((resolve) => {
      cdp.on('Page.compilationCacheProduced', (e) => e.url === url && resolve(e.data));
      timer = setTimeout(() => resolve(null), PRODUCE_TIMEOUT_MS);
    });
    await cdp.send('Page.produceCompilationCache', { scripts: [{ url, eager: true }] });
    // The script runs too (the code is produced as it compiles, before it runs); whether it works here does not matter.
    await page.evaluate(loadClassic, url).catch(() => {});
    const data = await produced;
    return data || null;
  } finally {
    // Also when a command fails (a browser without Page.produceCompilationCache): the timer would hold the process.
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

/** Runs in a page: loads a classic script by URL; true once it ran, false if it failed to load. */
const loadClassic = (url: string) =>
  new Promise<boolean>((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => (s.remove(), resolve(true));
    s.onerror = () => (s.remove(), resolve(false));
    (document.head ?? document.documentElement).append(s);
  });

/**
 * A page's copy of a host script's code, for the script at one URL. Sending it takes ~40 ms (1.7 MB
 * for axe-core), so a tab gets it as it is prepared, before its run; it applies while the tab lives
 * (or until close), to that URL only.
 */
export class PageCode {
  /** True once the page has the code. */
  readonly ready: Promise<boolean>;
  private cdp: CDPSession | null = null;
  private closed = false;
  private url: string;

  constructor(page: Page, url: string, data: Promise<string | null>) {
    this.url = url;
    this.ready = (async () => {
      const code = await data;
      if (!code || this.closed) return false;
      const cdp = (this.cdp = await page.context().newCDPSession(page));
      // DevTools consults the code only for a page whose Page domain is enabled in that session.
      await cdp.send('Page.enable');
      await cdp.send('Page.addCompilationCache', { url, data: code });
      return !this.closed;
    })().catch(() => false);
  }

  /** Loads the script into a frame of the page with its code: true once it ran; false if the page has no code (yet) or it failed to load. */
  async load(frame: Frame): Promise<boolean> {
    if (!(await Promise.race([this.ready, false]))) return false;
    return frame.evaluate(loadClassic, this.url).catch(() => false);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ready;
    await this.cdp?.detach().catch(() => {});
  }
}
