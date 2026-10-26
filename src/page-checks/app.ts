/**
 * The page checks' `app`: the app's frame as a Playwright Frame (navigation, waits, evaluate, and
 * the shortcuts that take a selector).
 */
import { type Text, Locatable, Locator } from './locator.ts';
import { settings, appIframe, appWindow, appDocument, sleep, poll, named, matchesUrl } from './frame.ts';

async function navigate(go: () => void, timeout: number, waitUntil?: string): Promise<void> {
  const frame = appIframe();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(named('TimeoutError', `navigation: Timeout ${timeout}ms exceeded`)), timeout);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    go();
  });
  if (waitUntil === 'networkidle') await sleep(500);
}

export class App extends Locatable {
  private base: string;
  constructor(base: string) {
    super('');
    this.base = base;
  }
  appUrl = (path: string) => new URL(path.replace(/^\/+/, ''), this.base).href;
  url(): string {
    return appWindow().location.href;
  }
  async title(): Promise<string> {
    return appDocument().title;
  }
  async content(): Promise<string> {
    return appDocument().documentElement.outerHTML;
  }
  async goto(url: string, options: { timeout?: number; waitUntil?: string } = {}): Promise<null> {
    const target = new URL(url, this.url()).href;
    await navigate(() => (appIframe().src = target), options.timeout ?? settings.checkTimeoutMs, options.waitUntil);
    return null;
  }
  async reload(options: { timeout?: number; waitUntil?: string } = {}): Promise<null> {
    await navigate(() => appWindow().location.reload(), options.timeout ?? settings.checkTimeoutMs, options.waitUntil);
    return null;
  }
  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? settings.checkTimeoutMs;
    const ok = await poll(timeout, () => {
      try {
        const ready = appDocument().readyState;
        return (state === 'domcontentloaded' ? ready !== 'loading' : ready === 'complete') || undefined;
      } catch {
        return undefined;
      }
    });
    if (!ok) throw named('TimeoutError', `app.waitForLoadState: Timeout ${timeout}ms exceeded`);
    if (state === 'networkidle') await sleep(500);
  }
  async waitForURL(url: Text, options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? settings.checkTimeoutMs;
    const ok = await poll(timeout, () => matchesUrl(this.url(), url, this.base) || undefined);
    if (!ok) throw named('TimeoutError', `app.waitForURL: Timeout ${timeout}ms exceeded waiting for ${String(url)}`);
  }
  async waitForSelector(selector: string, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    await this.locator(selector).waitFor(options);
  }
  /** Runs `fn` in the app's window, as Playwright runs it in the page: no closures over the checks' variables. */
  async evaluate<R, A>(fn: string | ((arg: A) => R), arg?: A): Promise<R> {
    const win = appWindow() as unknown as { eval(code: string): unknown };
    if (typeof fn === 'string') return win.eval(fn) as R;
    return (win.eval(`(${fn.toString()})`) as (a: A) => R)(arg as A);
  }
  // Frame shortcuts that take a selector.
  click(selector: string, options?: Parameters<Locator['click']>[0]) {
    return this.locator(selector).click(options);
  }
  fill(selector: string, value: string, options?: Parameters<Locator['fill']>[1]) {
    return this.locator(selector).fill(value, options);
  }
  press(selector: string, key: string, options?: Parameters<Locator['press']>[1]) {
    return this.locator(selector).press(key, options);
  }
  check(selector: string, options?: Parameters<Locator['check']>[0]) {
    return this.locator(selector).check(options);
  }
  textContent(selector: string) {
    return this.locator(selector).textContent();
  }
  isVisible(selector: string) {
    return this.locator(selector).isVisible();
  }
}
