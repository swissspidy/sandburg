/**
 * When the functional checks may start (HostApi.settled): once a click on the app does what it
 * would once the app has loaded. A server-rendered page is visible before its client code has
 * hydrated it, and a click before then is lost: a check that retries it (toPass) first waits out its
 * inner assertion's timeout.
 */
import type { Activity } from './types.ts';

/**
 * The app's servers are quiet: no request from the page for `quietMs`, and none in flight that was
 * sent within `longMs` (an event stream or a long poll stays open).
 */
export function quiet(a: Activity, quietMs: number, longMs: number): boolean {
  return (a.sinceRequestMs ?? 0) >= quietMs && (a.newestInflightMs == null || a.newestInflightMs >= longMs);
}

/**
 * Whether the app's framework says that input is no longer lost, where it says so, else undefined
 * (then quiet() decides). Only reads the app's window (the host page's own origin).
 *
 * - Solid's server-rendered page records events until it has hydrated (`_$HY`), but replaying one
 *   does not reach the app's handlers: an event that has finished dispatching has no composedPath().
 *   A fill() before then was lost. Hydrated: every server-rendered element (`data-hk`) in the page is
 *   one Solid has claimed (`_$HY.completed`), or Solid has let go of what it recorded (`completed`
 *   cleared, once it is done and has replayed its events). `_$HY.done` alone does not say so: Solid
 *   sets it when it handles its first event once hydration has begun, which can be a click on an
 *   element it has claimed while a lazy route's are not yet (and SolidStart sets it when the URL
 *   changed before hydration, then renders afresh). SolidStart goes on loading its dev overlay's
 *   modules for seconds after.
 * - React, once its root is created (hydrateRoot), replays a click on what it has not hydrated yet
 *   (Next.js and React Router hydrate the document).
 * - Nuxt mounts its app before its page component has hydrated (`isHydrating`), and its requests
 *   pause for 100 ms and more meanwhile.
 * - SvelteKit's page (its dev script sets `__sveltekit_dev`) is hydrated in one pass once its modules
 *   have loaded and run, and Svelte's dev build gives each element it hydrates `__svelte_meta`. Its
 *   requests can pause for 100 ms while the last modules run: a check then lost its first click.
 */
export function inputSafe(w: (Window & { _$HY?: unknown }) | null): boolean | undefined {
  try {
    if (!w) return undefined;
    const doc = w.document;
    if (w._$HY && typeof w._$HY === 'object') {
      const completed = (w._$HY as { completed?: WeakSet<Element> | null }).completed;
      if (!completed) return true;
      // All of them: a lazy route's elements come after the page's (WeakSet lookups are cheap).
      for (const e of doc.body?.querySelectorAll('[data-hk]') ?? []) if (!completed.has(e)) return false;
      return true;
    }
    const reactRoot = (node: Node | null) => !!node && Object.keys(node).some((k) => k.startsWith('__reactContainer$'));
    if ([doc, doc.body, doc.getElementById('root'), doc.getElementById('app'), doc.getElementById('__next')].some(reactRoot)) return true;
    if ('__sveltekit_dev' in w) return [...(doc.body?.querySelectorAll('*') ?? [])].slice(0, 200).some((e) => '__svelte_meta' in e);
    const nuxt = doc.getElementById('__nuxt') as (Element & { __vue_app__?: { config?: { globalProperties?: { $nuxt?: { isHydrating?: unknown } } } } }) | null;
    if (!nuxt) return undefined;
    const app = nuxt.__vue_app__?.config?.globalProperties?.$nuxt;
    return !!app && app.isHydrating === false;
  } catch {
    return undefined;
  }
}

/**
 * Waits until the app has settled (HostApi.settled): its framework's word (inputSafe) where it gives
 * it, else its servers being quiet; at most `maxMs`, or `hydrateMaxMs` while its framework says it has
 * not hydrated yet. Whether it settled; null without a runtime that reports its activity.
 */
export async function settle(o: {
  activity: () => Activity | null | undefined;
  safe: () => boolean | undefined;
  quietMs: number;
  longMs: number;
  maxMs: number;
  hydrateMaxMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<boolean | null> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    const a = o.activity();
    if (!a || a.sinceRequestMs === undefined) return null;
    const safe = o.safe();
    if (safe ?? quiet(a, o.quietMs, o.longMs)) return true;
    // A framework that says it has not hydrated yet is waited for longer (a cold SolidStart page).
    const left = start + (safe === false ? o.hydrateMaxMs : o.maxMs) - now();
    if (left <= 0) return false;
    await sleep(Math.min(left, o.pollMs));
  }
}
