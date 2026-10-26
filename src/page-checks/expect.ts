/**
 * The page checks' expect: Playwright's web-first assertions on locators and the page, which retry
 * until they pass or time out, and its value assertions.
 */
import { getAriaChecked, getAriaDisabled, getAriaRole, getElementAccessibleName, isElementVisible } from 'ivya/utils';
import { type Text, editable, normalize, Locator, safeElements } from './locator.ts';
import { named, matchesUrl, appDocument, poll, guarded } from './frame.ts';
import { App } from './app.ts';

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

export function makeExpect(defaultTimeout: number) {
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
