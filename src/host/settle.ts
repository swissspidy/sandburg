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
 * - Solid's server-rendered page records events until it has hydrated, and replays them (`_$HY`).
 *   SolidStart goes on loading its dev overlay's modules for seconds after.
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
    if (w._$HY && typeof w._$HY === 'object') return true;
    const reactRoot = (node: Node | null) => !!node && Object.keys(node).some((k) => k.startsWith('__reactContainer$'));
    if ([doc, doc.body, doc.getElementById('root'), doc.getElementById('app'), doc.getElementById('__next')].some(reactRoot)) return true;
    if (Object.keys(w).some((k) => k.startsWith('__sveltekit_'))) return [...(doc.body?.querySelectorAll('*') ?? [])].slice(0, 200).some((e) => '__svelte_meta' in e);
    const nuxt = doc.getElementById('__nuxt') as (Element & { __vue_app__?: { config?: { globalProperties?: { $nuxt?: { isHydrating?: unknown } } } } }) | null;
    if (!nuxt) return undefined;
    const app = nuxt.__vue_app__?.config?.globalProperties?.$nuxt;
    return !!app && app.isHydrating === false;
  } catch {
    return undefined;
  }
}
