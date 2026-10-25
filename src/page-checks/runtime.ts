/**
 * Checks that run in the page (`--checks-in page`): the checks file's code runs in Sandburg's tab,
 * next to the app's frame, not in Sandburg's Node process. The tab and the app share an origin
 * (ADR 0004), so the checks can do no more than the app's own code. They get a Playwright-shaped
 * `app`, `page` and `expect`:
 *
 * - locators are Playwright's selectors, resolved by ivya (a fork of Playwright's locator
 *   resolution): the same getByRole, getByLabel, getByText … matching as on the host;
 * - input comes from Testing Library's user-event (pointer, keyboard and focus events in order),
 *   and fill() inserts text as Playwright does (one input event). Events made by a script are not
 *   trusted (`isTrusted` is false): CSS :hover does not apply, and a native select's list does not
 *   open;
 * - actions and assertions wait as Playwright's do, for the element to appear, be visible and
 *   enabled, or for the assertion to hold.
 *
 * Bundled by page-checks/index.ts; installed as window.__sandburgPageChecks.
 */
import {
  Ivya,
  asLocator,
  getByAltTextSelector,
  getByLabelSelector,
  getByPlaceholderSelector,
  getByRoleSelector,
  getByTestIdSelector,
  getByTextSelector,
  getByTitleSelector,
} from 'ivya';
import { getAriaChecked, getAriaDisabled, getAriaRole, getElementAccessibleName, isElementVisible } from 'ivya/utils';
import { userEvent } from '@testing-library/user-event';

import type { PageCheckResult, PageChecksOptions, PageChecksOutput } from './types.ts';

const ivya = Ivya.create({ browser: 'chromium', testIdAttribute: 'data-testid' });
let settings: PageChecksOptions = { checkTimeoutMs: 30_000, expectTimeoutMs: 5_000 };

// --- the app's frame ---------------------------------------------------------------------------

function appIframe(): HTMLIFrameElement {
  const frame = document.getElementById('app');
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('the app frame is not there');
  return frame;
}
const appWindow = (): Window & typeof globalThis => appIframe().contentWindow as Window & typeof globalThis;
function appDocument(): Document {
  const doc = appIframe().contentDocument;
  if (!doc) throw new Error('the app frame has no document');
  return doc;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How long to wait between tries, as Playwright does. */
const POLL_MS = [0, 20, 50, 100, 100, 250];

/** Polls until `attempt` returns a value (not undefined), or the time is up (then undefined). */
async function poll<T>(timeoutMs: number, attempt: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (let i = 0; ; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) return undefined;
    await sleep(Math.min(POLL_MS[Math.min(i, POLL_MS.length - 1)], Math.max(0, deadline - performance.now())));
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An error named as Playwright names it, so the result tells a failed assertion from a broken check. */
function named(name: 'AssertionError' | 'TimeoutError', text: string): Error {
  const error = new Error(text);
  error.name = name;
  return error;
}
const isFailure = (e: unknown) => e instanceof Error && (e.name === 'AssertionError' || e.name === 'TimeoutError');

// --- locators ----------------------------------------------------------------------------------

type Text = string | RegExp;
interface FilterOptions {
  hasText?: Text;
  hasNotText?: Text;
  has?: Locator;
  hasNot?: Locator;
  visible?: boolean;
}

/** Playwright's escapeForTextSelector: a string matches case-insensitively, `exact` strictly. */
function textBody(text: Text, exact = false): string {
  if (typeof text !== 'string') {
    if (text.unicode || (text as RegExp & { unicodeSets?: boolean }).unicodeSets) return String(text);
    return String(text).replace(/(^|[^\\])(\\\\)*(["'`])/g, '$1$2\\$3').replace(/>>/g, '\\>\\>');
  }
  return `${JSON.stringify(text)}${exact ? 's' : 'i'}`;
}

function filterSelector(options: FilterOptions = {}): string[] {
  const parts: string[] = [];
  if (options.hasText !== undefined) parts.push(`internal:has-text=${textBody(options.hasText)}`);
  if (options.hasNotText !== undefined) parts.push(`internal:has-not-text=${textBody(options.hasNotText)}`);
  if (options.has) parts.push(`internal:has=${JSON.stringify(options.has.selector)}`);
  if (options.hasNot) parts.push(`internal:has-not=${JSON.stringify(options.hasNot.selector)}`);
  if (options.visible !== undefined) parts.push(`visible=${options.visible}`);
  return parts;
}

interface ActionNeeds {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
}

function editable(el: Element): boolean {
  if (el instanceof el.ownerDocument.defaultView!.HTMLInputElement || el instanceof el.ownerDocument.defaultView!.HTMLTextAreaElement) {
    return !(el as HTMLInputElement).readOnly;
  }
  if (el.tagName === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

const normalize = (s: string) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();

/** Where the locator methods live: on the app (the frame) and on every locator. */
class Locatable {
  readonly selector: string;
  constructor(selector: string) {
    this.selector = selector;
  }

  protected chain(next: string): Locator {
    return new Locator(this.selector ? `${this.selector} >> ${next}` : next);
  }
  locator(selector: string | Locator, options?: FilterOptions): Locator {
    const next = typeof selector === 'string' ? selector : `internal:chain=${JSON.stringify(selector.selector)}`;
    return [...filterSelector(options)].reduce((l, part) => l.chainRaw(part), this.chain(next));
  }
  getByRole(role: string, options?: Parameters<typeof getByRoleSelector>[1]): Locator {
    return this.chain(getByRoleSelector(role, options));
  }
  getByLabel(text: Text, options?: { exact?: boolean }): Locator {
    return this.chain(getByLabelSelector(text, options));
  }
  getByText(text: Text, options?: { exact?: boolean }): Locator {
    return this.chain(getByTextSelector(text, options));
  }
  getByPlaceholder(text: Text, options?: { exact?: boolean }): Locator {
    return this.chain(getByPlaceholderSelector(text, options));
  }
  getByTitle(text: Text, options?: { exact?: boolean }): Locator {
    return this.chain(getByTitleSelector(text, options));
  }
  getByAltText(text: Text, options?: { exact?: boolean }): Locator {
    return this.chain(getByAltTextSelector(text, options));
  }
  getByTestId(id: Text): Locator {
    return this.chain(getByTestIdSelector('data-testid', id));
  }
}

export class Locator extends Locatable {
  chainRaw(part: string): Locator {
    return this.chain(part);
  }
  toString(): string {
    try {
      return asLocator('javascript', this.selector);
    } catch {
      return this.selector;
    }
  }

  // --- narrowing ---
  filter(options: FilterOptions): Locator {
    return filterSelector(options).reduce<Locator>((l, part) => l.chainRaw(part), this);
  }
  first(): Locator {
    return this.chain('nth=0');
  }
  last(): Locator {
    return this.chain('nth=-1');
  }
  nth(index: number): Locator {
    return this.chain(`nth=${index}`);
  }
  and(other: Locator): Locator {
    return this.chain(`internal:and=${JSON.stringify(other.selector)}`);
  }
  or(other: Locator): Locator {
    return this.chain(`internal:or=${JSON.stringify(other.selector)}`);
  }

  // --- resolution ---
  /** The elements it matches now. */
  elements(): Element[] {
    return ivya.queryLocatorSelectorAll(this.selector, appDocument());
  }
  /** The one element it matches, once there is one (and it can take the action), or an error as Playwright words it. */
  async element(action: string, needs: ActionNeeds = {}, timeout = settings.checkTimeoutMs): Promise<Element> {
    let why = '';
    const found = await poll(timeout, () => {
      let els: Element[];
      try {
        els = this.elements();
      } catch {
        return undefined; // the frame is between documents
      }
      if (els.length > 1) {
        throw new Error(`${action}: Error: strict mode violation: ${this} resolved to ${els.length} elements`);
      }
      const el = els[0];
      if (!el) return undefined;
      if (needs.visible && !isElementVisible(el)) return void (why = 'element is not visible');
      if (needs.enabled && getAriaDisabled(el)) return void (why = 'element is not enabled');
      if (needs.editable && !editable(el)) return void (why = 'element is not editable');
      return el;
    });
    if (found) return found;
    throw named('TimeoutError', `${action}: Timeout ${timeout}ms exceeded.\nCall log:\n  - waiting for ${this}${why ? `\n  - ${why}` : ''}`);
  }

  // --- actions ---
  private needs(force?: boolean, needs: ActionNeeds = { visible: true, enabled: true }): ActionNeeds {
    return force ? {} : needs;
  }
  private user(force?: boolean) {
    return userEvent.setup({ document: appDocument(), pointerEventsCheck: force ? 0 : undefined });
  }
  async click(options: { force?: boolean; timeout?: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: string[] } = {}): Promise<void> {
    const el = await this.element('locator.click', this.needs(options.force), options.timeout);
    const user = this.user(options.force);
    const mods = options.modifiers ?? [];
    if (mods.length) await user.keyboard(mods.map((m) => `{${modifier(m)}>}`).join(''));
    if (options.button === 'right') await user.pointer({ keys: '[MouseRight]', target: el });
    else if ((options.clickCount ?? 1) >= 2) await user.dblClick(el);
    else await user.click(el);
    if (mods.length) await user.keyboard(mods.map((m) => `{/${modifier(m)}}`).join(''));
  }
  async dblclick(options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const el = await this.element('locator.dblclick', this.needs(options.force), options.timeout);
    await this.user(options.force).dblClick(el);
  }
  async hover(options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const el = await this.element('locator.hover', this.needs(options.force, { visible: true }), options.timeout);
    await this.user(options.force).hover(el);
  }
  async focus(options: { timeout?: number } = {}): Promise<void> {
    ((await this.element('locator.focus', {}, options.timeout)) as HTMLElement).focus();
  }
  async blur(options: { timeout?: number } = {}): Promise<void> {
    ((await this.element('locator.blur', {}, options.timeout)) as HTMLElement).blur();
  }
  /** As Playwright: focus, select what is there, insert the text (one input event); date and similar inputs get their value set. */
  async fill(value: string, options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const el = (await this.element('locator.fill', this.needs(options.force, { visible: true, enabled: true, editable: true }), options.timeout)) as HTMLElement;
    const win = el.ownerDocument.defaultView!;
    const doc = el.ownerDocument;
    if (el instanceof win.HTMLInputElement && SET_VALUE_TYPES.has(el.type)) {
      setNativeValue(el, value);
      el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return;
    }
    el.focus();
    if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) el.select();
    else win.getSelection()?.selectAllChildren(el);
    const done = value ? doc.execCommand('insertText', false, value) : doc.execCommand('delete', false);
    if (!done && (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement)) {
      setNativeValue(el, value);
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    }
  }
  clear(options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    return this.fill('', options);
  }
  async press(key: string, options: { timeout?: number } = {}): Promise<void> {
    const el = (await this.element('locator.press', {}, options.timeout)) as HTMLElement;
    el.focus();
    await this.user().keyboard(keySequence(key));
  }
  async pressSequentially(text: string, options: { timeout?: number } = {}): Promise<void> {
    const el = (await this.element('locator.pressSequentially', { visible: true, enabled: true }, options.timeout)) as HTMLElement;
    el.focus();
    await this.user().keyboard(escapeKeys(text));
  }
  type(text: string, options: { timeout?: number } = {}): Promise<void> {
    return this.pressSequentially(text, options);
  }
  async setChecked(checked: boolean, options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const action = `locator.${checked ? 'check' : 'uncheck'}`;
    const el = await this.element(action, this.needs(options.force), options.timeout);
    const state = () => getAriaChecked(el) === true;
    if (state() === checked) return;
    await this.user(options.force).click(el);
    if (state() !== checked) throw new Error(`${action}: Clicking the checkbox did not change its state`);
  }
  check(options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    return this.setChecked(true, options);
  }
  uncheck(options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    return this.setChecked(false, options);
  }
  async selectOption(
    values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }>,
    options: { force?: boolean; timeout?: number } = {},
  ): Promise<string[]> {
    const select = (await this.element('locator.selectOption', this.needs(options.force), options.timeout)) as HTMLSelectElement;
    const all = [...select.options];
    const wanted = (Array.isArray(values) ? values : [values]).map((v) => {
      const option = all.find((o, i) =>
        typeof v === 'string'
          ? o.value === v || normalize(o.label) === normalize(v)
          : (v.value === undefined || o.value === v.value) && (v.label === undefined || normalize(o.label) === normalize(v.label)) && (v.index === undefined || i === v.index),
      );
      if (!option) throw new Error(`locator.selectOption: no option matches ${JSON.stringify(v)} in ${this}`);
      return option;
    });
    await this.user(options.force).selectOptions(select, wanted);
    return wanted.map((o) => o.value);
  }
  async dispatchEvent(type: string, init: EventInit = {}): Promise<void> {
    const el = await this.element('locator.dispatchEvent');
    el.dispatchEvent(new (el.ownerDocument.defaultView!.Event)(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }
  async scrollIntoViewIfNeeded(): Promise<void> {
    (await this.element('locator.scrollIntoViewIfNeeded')).scrollIntoView({ block: 'center' });
  }
  async waitFor(options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const timeout = options.timeout ?? settings.checkTimeoutMs;
    const ok = await poll(timeout, () => {
      const els = safeElements(this);
      const visible = els.some((e) => isElementVisible(e));
      const met = state === 'attached' ? els.length > 0 : state === 'detached' ? els.length === 0 : state === 'visible' ? visible : !visible;
      return met || undefined;
    });
    if (!ok) throw named('TimeoutError', `locator.waitFor: Timeout ${timeout}ms exceeded.\nCall log:\n  - waiting for ${this} to be ${state}`);
  }

  // --- reading ---
  async count(): Promise<number> {
    return safeElements(this).length;
  }
  async all(): Promise<Locator[]> {
    return safeElements(this).map((_, i) => this.nth(i));
  }
  async textContent(options: { timeout?: number } = {}): Promise<string | null> {
    return (await this.element('locator.textContent', {}, options.timeout)).textContent;
  }
  async innerText(options: { timeout?: number } = {}): Promise<string> {
    return ((await this.element('locator.innerText', {}, options.timeout)) as HTMLElement).innerText;
  }
  async innerHTML(options: { timeout?: number } = {}): Promise<string> {
    return (await this.element('locator.innerHTML', {}, options.timeout)).innerHTML;
  }
  async inputValue(options: { timeout?: number } = {}): Promise<string> {
    return ((await this.element('locator.inputValue', {}, options.timeout)) as HTMLInputElement).value;
  }
  async getAttribute(name: string, options: { timeout?: number } = {}): Promise<string | null> {
    return (await this.element('locator.getAttribute', {}, options.timeout)).getAttribute(name);
  }
  async allTextContents(): Promise<string[]> {
    return safeElements(this).map((e) => e.textContent ?? '');
  }
  async allInnerTexts(): Promise<string[]> {
    return safeElements(this).map((e) => (e as HTMLElement).innerText);
  }
  async isVisible(): Promise<boolean> {
    const el = safeElements(this)[0];
    return !!el && isElementVisible(el);
  }
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }
  async isChecked(options: { timeout?: number } = {}): Promise<boolean> {
    return getAriaChecked(await this.element('locator.isChecked', {}, options.timeout)) === true;
  }
  async isEnabled(options: { timeout?: number } = {}): Promise<boolean> {
    return !getAriaDisabled(await this.element('locator.isEnabled', {}, options.timeout));
  }
  async isDisabled(options: { timeout?: number } = {}): Promise<boolean> {
    return getAriaDisabled(await this.element('locator.isDisabled', {}, options.timeout));
  }
  async isEditable(options: { timeout?: number } = {}): Promise<boolean> {
    return editable(await this.element('locator.isEditable', {}, options.timeout));
  }
  async evaluate<R, A>(fn: (el: Element, arg: A) => R, arg?: A): Promise<R> {
    return fn(await this.element('locator.evaluate'), arg as A);
  }
  async evaluateAll<R, A>(fn: (els: Element[], arg: A) => R, arg?: A): Promise<R> {
    return fn(safeElements(this), arg as A);
  }
}

function safeElements(locator: Locator): Element[] {
  try {
    return locator.elements();
  } catch {
    return [];
  }
}

/** Input types whose value is set rather than typed, as Playwright's fill() does. */
const SET_VALUE_TYPES = new Set(['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']);

/** Sets an input's value so that frameworks tracking it (React) see the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function modifier(name: string): string {
  return name === 'ControlOrMeta' ? 'Control' : name;
}
/** Text for user-event's keyboard(): its { and [ start key names, so they are doubled. */
const escapeKeys = (text: string) => text.replace(/[{[]/g, (c) => c + c);
/** A Playwright key ("Enter", "Control+a", "Shift+ArrowLeft") as user-event's keyboard() sequence. */
function keySequence(key: string): string {
  const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
  const main = parts.pop()!;
  const mods = parts.map(modifier);
  const press = main.length === 1 ? escapeKeys(main) : `{${main}}`;
  return mods.map((m) => `{${m}>}`).join('') + press + [...mods].reverse().map((m) => `{/${m}}`).join('');
}

// --- the app (a frame) and the page ------------------------------------------------------------

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

class App extends Locatable {
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

function matchesUrl(actual: string, expected: Text, base: string): boolean {
  return typeof expected === 'string' ? actual === new URL(expected, base).href : expected.test(actual);
}

/** The keyboard, on the element that has focus in the app. */
const keyboard = {
  press: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(keySequence(key)),
  type: (text: string) => userEvent.setup({ document: appDocument() }).keyboard(escapeKeys(text)),
  insertText: async (text: string) => void appDocument().execCommand('insertText', false, text),
  down: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{${modifier(key)}>}`),
  up: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{/${modifier(key)}}`),
};

/** Anything else a check reaches for is not there: say so by name rather than "is not a function". */
function guarded<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in t || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return Reflect.get(t, prop, receiver);
      return () => {
        throw new Error(`${label}.${String(prop)} is not available in checks that run in the page (--checks-in page)`);
      };
    },
  });
}

// --- expect ------------------------------------------------------------------------------------

interface Outcome {
  pass: boolean;
  /** What the assertion looked at, for the message. */
  received: unknown;
}
interface Matcher {
  name: string;
  /** "Expected substring", "Expected", …: how the message introduces `expected`. */
  label: string;
  expected: unknown;
  /** Locator matchers poll; value matchers check once. */
  check: () => Outcome;
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof RegExp) return String(v);
  if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** The message Playwright's assertions fail with: what was expected, what the page had. */
function failure(subject: string, locator: string | null, negated: boolean, m: Matcher, outcome: Outcome, timeout?: number): Error {
  const lines = [`expect(${subject})${negated ? '.not' : ''}.${m.name}(${m.expected === undefined ? '' : 'expected'}) failed`, ''];
  if (locator) lines.push(`Locator: ${locator}`);
  if (m.expected !== undefined) lines.push(`${m.label}: ${negated ? 'not ' : ''}${show(m.expected)}`);
  lines.push(`Received: ${show(outcome.received)}`);
  if (timeout !== undefined) lines.push(`Timeout: ${timeout}ms`);
  return named('AssertionError', lines.join('\n'));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k)));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const textMatches = (actual: string, expected: Text, contains: boolean, ignoreCase?: boolean): boolean => {
  if (expected instanceof RegExp) return expected.test(actual);
  const [a, e] = ignoreCase ? [actual.toLowerCase(), normalize(expected).toLowerCase()] : [actual, normalize(expected)];
  return contains ? a.includes(e) : a === e;
};

function locatorMatchers(locator: Locator): Record<string, (...args: never[]) => Matcher> {
  const one = (): Element | null => {
    const els = safeElements(locator);
    if (els.length > 1) throw new Error(`strict mode violation: ${locator} resolved to ${els.length} elements`);
    return els[0] ?? null;
  };
  const text = (el: Element, inner?: boolean) => normalize(inner ? (el as HTMLElement).innerText : (el.textContent ?? ''));
  type TextOptions = { useInnerText?: boolean; ignoreCase?: boolean; timeout?: number };
  const textMatcher = (name: string, contains: boolean) => (expected: Text | Text[], options: TextOptions = {}): Matcher => ({
    name,
    label: Array.isArray(expected) ? 'Expected' : contains ? (typeof expected === 'string' ? 'Expected substring' : 'Expected pattern') : typeof expected === 'string' ? 'Expected string' : 'Expected pattern',
    expected,
    check: () => {
      if (Array.isArray(expected)) {
        const texts = safeElements(locator).map((e) => text(e, options.useInnerText));
        return { pass: texts.length === expected.length && expected.every((x, i) => textMatches(texts[i], x, contains, options.ignoreCase)), received: texts };
      }
      const el = one();
      const t = el ? text(el, options.useInnerText) : null;
      return { pass: t !== null && textMatches(t, expected, contains, options.ignoreCase), received: el ? t : '<element(s) not found>' };
    },
  });
  const state = (name: string, test: (el: Element) => boolean, absent = false, label = 'Expected', expected?: unknown) => (): Matcher => ({
    name,
    label,
    expected,
    check: () => {
      const el = one();
      if (!el) return { pass: absent, received: '<element(s) not found>' };
      const pass = test(el);
      return { pass, received: pass ? name.replace(/^toBe/, '').toLowerCase() : `not ${name.replace(/^toBe/, '').toLowerCase()}` };
    },
  });
  return {
    toBeVisible: (options: { visible?: boolean } = {}) =>
      options.visible === false ? state('toBeHidden', (e) => !isElementVisible(e), true)() : state('toBeVisible', (e) => isElementVisible(e))(),
    toBeHidden: state('toBeHidden', (e) => !isElementVisible(e), true),
    toBeAttached: (options: { attached?: boolean } = {}) => ({
      name: 'toBeAttached',
      label: 'Expected',
      expected: undefined,
      check: () => {
        const n = safeElements(locator).length;
        return { pass: options.attached === false ? n === 0 : n > 0, received: n ? 'attached' : 'detached' };
      },
    }),
    toBeChecked: (options: { checked?: boolean } = {}) =>
      state('toBeChecked', (e) => (getAriaChecked(e) === true) === (options.checked ?? true))(),
    toBeEnabled: state('toBeEnabled', (e) => !getAriaDisabled(e)),
    toBeDisabled: state('toBeDisabled', (e) => getAriaDisabled(e)),
    toBeEditable: state('toBeEditable', (e) => editable(e)),
    toBeFocused: state('toBeFocused', (e) => e.ownerDocument.activeElement === e),
    toBeEmpty: state('toBeEmpty', (e) => ('value' in e && typeof (e as HTMLInputElement).value === 'string' && e.tagName !== 'BUTTON' ? (e as HTMLInputElement).value === '' : normalize(e.textContent ?? '') === '')),
    toHaveText: textMatcher('toHaveText', false),
    toContainText: textMatcher('toContainText', true),
    toHaveValue: (expected: Text) => ({
      name: 'toHaveValue',
      label: 'Expected',
      expected,
      check: () => {
        const el = one() as HTMLInputElement | null;
        const v = el ? el.value : null;
        return { pass: v !== null && (expected instanceof RegExp ? expected.test(v) : v === expected), received: v ?? '<element(s) not found>' };
      },
    }),
    toHaveCount: (expected: number) => ({
      name: 'toHaveCount',
      label: 'Expected',
      expected,
      check: () => {
        const n = safeElements(locator).length;
        return { pass: n === expected, received: n };
      },
    }),
    toHaveAttribute: (name: string, value?: Text) => ({
      name: 'toHaveAttribute',
      label: 'Expected',
      expected: value === undefined ? name : `${name}=${String(value)}`,
      check: () => {
        const el = one();
        const v = el?.getAttribute(name) ?? null;
        const pass = v !== null && (value === undefined || (value instanceof RegExp ? value.test(v) : v === value));
        return { pass, received: v };
      },
    }),
    toHaveClass: (expected: Text) => ({
      name: 'toHaveClass',
      label: 'Expected',
      expected,
      check: () => {
        const v = one()?.getAttribute('class') ?? '';
        return { pass: expected instanceof RegExp ? expected.test(v) : normalize(v) === normalize(expected), received: v };
      },
    }),
    toHaveId: (expected: Text) => ({
      name: 'toHaveId',
      label: 'Expected',
      expected,
      check: () => {
        const v = one()?.id ?? '';
        return { pass: expected instanceof RegExp ? expected.test(v) : v === expected, received: v };
      },
    }),
    toHaveAccessibleName: (expected: Text) => ({
      name: 'toHaveAccessibleName',
      label: 'Expected',
      expected,
      check: () => {
        const el = one();
        const v = el ? normalize(getElementAccessibleName(el, false)) : '';
        return { pass: textMatches(v, expected, false), received: v };
      },
    }),
    toHaveRole: (expected: string) => ({
      name: 'toHaveRole',
      label: 'Expected',
      expected,
      check: () => {
        const el = one();
        const v = el ? getAriaRole(el) : null;
        return { pass: v === expected, received: v };
      },
    }),
  };
}

function appMatchers(app: App): Record<string, (...args: never[]) => Matcher> {
  return {
    toHaveURL: (expected: Text) => ({
      name: 'toHaveURL',
      label: 'Expected',
      expected,
      check: () => ({ pass: matchesUrl(app.url(), expected, app.appUrl('/')), received: app.url() }),
    }),
    toHaveTitle: (expected: Text) => ({
      name: 'toHaveTitle',
      label: 'Expected',
      expected,
      check: () => {
        const t = normalize(appDocument().title);
        return { pass: textMatches(t, expected, false), received: t };
      },
    }),
  };
}

type ValueMatcher = (...args: never[]) => Matcher;
function valueMatchers(actual: unknown): Record<string, ValueMatcher> {
  const m = (name: string, expected: unknown, pass: () => boolean, label = 'Expected'): Matcher => ({ name, label, expected, check: () => ({ pass: pass(), received: actual }) });
  const num = () => actual as number;
  return {
    toBe: (e: unknown) => m('toBe', e, () => Object.is(actual, e)),
    toEqual: (e: unknown) => m('toEqual', e, () => deepEqual(actual, e)),
    toStrictEqual: (e: unknown) => m('toStrictEqual', e, () => deepEqual(actual, e)),
    toBeTruthy: () => m('toBeTruthy', undefined, () => !!actual),
    toBeFalsy: () => m('toBeFalsy', undefined, () => !actual),
    toBeNull: () => m('toBeNull', undefined, () => actual === null),
    toBeUndefined: () => m('toBeUndefined', undefined, () => actual === undefined),
    toBeDefined: () => m('toBeDefined', undefined, () => actual !== undefined),
    toBeNaN: () => m('toBeNaN', undefined, () => Number.isNaN(actual)),
    toContain: (e: unknown) =>
      m('toContain', e, () => (typeof actual === 'string' ? actual.includes(String(e)) : Array.isArray(actual) ? actual.includes(e) : false)),
    toContainEqual: (e: unknown) => m('toContainEqual', e, () => Array.isArray(actual) && actual.some((x) => deepEqual(x, e))),
    toMatch: (e: Text) => m('toMatch', e, () => typeof actual === 'string' && (e instanceof RegExp ? e.test(actual) : actual.includes(e)), 'Expected pattern'),
    toHaveLength: (e: number) => m('toHaveLength', e, () => (actual as { length?: number })?.length === e),
    toHaveProperty: (path: string, value?: unknown) =>
      m('toHaveProperty', path, () => {
        let v: unknown = actual;
        for (const key of path.split('.')) {
          if (v === null || v === undefined || !(key in Object(v))) return false;
          v = (v as Record<string, unknown>)[key];
        }
        return value === undefined || deepEqual(v, value);
      }),
    toBeGreaterThan: (e: number) => m('toBeGreaterThan', e, () => num() > e),
    toBeGreaterThanOrEqual: (e: number) => m('toBeGreaterThanOrEqual', e, () => num() >= e),
    toBeLessThan: (e: number) => m('toBeLessThan', e, () => num() < e),
    toBeLessThanOrEqual: (e: number) => m('toBeLessThanOrEqual', e, () => num() <= e),
    toBeCloseTo: (e: number, digits = 2) => m('toBeCloseTo', e, () => Math.abs(num() - e) < 10 ** -digits / 2),
    toBeInstanceOf: (e: abstract new (...args: never[]) => unknown) => m('toBeInstanceOf', e?.name, () => actual instanceof e),
  };
}

/** Matchers on `subject`: `run` decides whether to poll. Each also under `.not`. */
function bind(matchers: Record<string, (...args: never[]) => Matcher>, run: (m: Matcher, negated: boolean, timeout?: number) => unknown) {
  const make = (negated: boolean) =>
    Object.fromEntries(
      Object.entries(matchers).map(([name, f]) => [
        name,
        (...args: unknown[]) => {
          const last = args.at(-1) as { timeout?: number } | undefined;
          const timeout = last && typeof last === 'object' && !(last instanceof RegExp) && !Array.isArray(last) ? last.timeout : undefined;
          return run((f as (...a: unknown[]) => Matcher)(...args), negated, timeout);
        },
      ]),
    );
  return Object.assign(make(false), { not: make(true) });
}

function makeExpect(defaultTimeout: number) {
  const polled = (subject: string, locator: string | null) => async (m: Matcher, negated: boolean, timeout = defaultTimeout) => {
    let last: Outcome = { pass: false, received: undefined };
    const ok = await poll(timeout, () => {
      last = m.check();
      return last.pass !== negated || undefined;
    });
    if (!ok) throw failure(subject, locator, negated, m, last, timeout);
  };
  const expect = (actual: unknown, _message?: string) => {
    if (actual instanceof Locator) return guarded(bind(locatorMatchers(actual), polled('locator', actual.toString())), 'expect(locator)');
    if (actual instanceof App) return guarded(bind(appMatchers(actual), polled('app', null)), 'expect(app)');
    return guarded(
      bind(valueMatchers(actual), (m, negated) => {
        const outcome = m.check();
        if (outcome.pass === negated) throw failure('received', null, negated, m, outcome);
      }),
      'expect(value)',
    );
  };
  /** Polls `fn` until the value matcher holds or the time is up. */
  const pollExpect = (fn: () => unknown, options: { timeout?: number } = {}) => {
    const timeout = options.timeout ?? defaultTimeout;
    const matcher = (name: string, negated: boolean) => async (...args: unknown[]) => {
      let m: Matcher | undefined;
      let last: Outcome = { pass: false, received: undefined };
      const ok = await poll(timeout, async () => {
        m = (valueMatchers(await fn())[name] as (...a: unknown[]) => Matcher)(...args);
        last = m.check();
        return last.pass !== negated || undefined;
      });
      if (!ok && m) throw failure('poll', null, negated, m, last, timeout);
    };
    const names = Object.keys(valueMatchers(undefined));
    const make = (negated: boolean) => Object.fromEntries(names.map((n) => [n, matcher(n, negated)]));
    return guarded(Object.assign(make(false), { not: make(true) }), 'expect.poll(…)');
  };
  return Object.assign(expect, {
    poll: pollExpect,
    configure: (options: { timeout?: number } = {}) => makeExpect(options.timeout ?? defaultTimeout),
    soft: (actual: unknown) => expect(actual),
  });
}

// --- running a checks file ---------------------------------------------------------------------

async function run(source: string, options: PageChecksOptions): Promise<PageChecksOutput> {
  settings = options;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let mod: { default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } catch (e) {
    return { error: `the checks file did not load: ${message(e)}` };
  } finally {
    URL.revokeObjectURL(url);
  }
  const checks = mod.default;
  if (!checks || typeof checks !== 'object' || Object.values(checks).some((fn) => typeof fn !== 'function')) {
    return { error: 'the checks file must default-export an object mapping check names to functions' };
  }
  const app = new App(new URL('.', appWindow().location.href).href);
  const context = {
    app: guarded(app, 'app'),
    page: guarded({ keyboard, waitForTimeout: (ms: number) => sleep(ms), goto: app.goto.bind(app), reload: app.reload.bind(app), url: app.url.bind(app) }, 'page'),
    expect: makeExpect(options.expectTimeoutMs),
    appUrl: app.appUrl,
  };
  const results: PageCheckResult[] = [];
  for (const [name, fn] of Object.entries(checks as Record<string, (ctx: typeof context) => unknown>)) {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn(context)),
        new Promise((_, reject) => (timer = setTimeout(() => reject(named('TimeoutError', `check "${name}" timed out`)), options.checkTimeoutMs))),
      ]);
      results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started) });
    } catch (e) {
      results.push({ name, status: isFailure(e) ? 'failed' : 'error', message: message(e), durationMs: Math.round(performance.now() - started) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { results };
}

window.__sandburgPageChecks = { run };
