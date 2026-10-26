/**
 * The page checks' locators: Playwright's Locator API over the app frame's DOM (ivya's selectors),
 * and the actions on what they find.
 */
import { asLocator, getByAltTextSelector, getByLabelSelector, getByPlaceholderSelector, getByRoleSelector, getByTestIdSelector, getByTextSelector, getByTitleSelector } from 'ivya';
import { getAriaChecked, getAriaDisabled, isElementVisible } from 'ivya/utils';
import { userEvent } from '@testing-library/user-event';
import { ivya, appDocument, settings, poll, named } from './frame.ts';

export type Text = string | RegExp;

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

export function editable(el: Element): boolean {
  if (el instanceof el.ownerDocument.defaultView!.HTMLInputElement || el instanceof el.ownerDocument.defaultView!.HTMLTextAreaElement) {
    return !(el as HTMLInputElement).readOnly;
  }
  if (el.tagName === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

export const normalize = (s: string) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();

/** Where the locator methods live: on the app (the frame) and on every locator. */
export class Locatable {
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

export function safeElements(locator: Locator): Element[] {
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

export function modifier(name: string): string {
  return name === 'ControlOrMeta' ? 'Control' : name;
}

/** Text for user-event's keyboard(): its { and [ start key names, so they are doubled. */
export const escapeKeys = (text: string) => text.replace(/[{[]/g, (c) => c + c);

/** A Playwright key ("Enter", "Control+a", "Shift+ArrowLeft") as user-event's keyboard() sequence. */
export function keySequence(key: string): string {
  const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
  const main = parts.pop()!;
  const mods = parts.map(modifier);
  const press = main.length === 1 ? escapeKeys(main) : `{${main}}`;
  return mods.map((m) => `{${m}>}`).join('') + press + [...mods].reverse().map((m) => `{/${m}}`).join('');
}
