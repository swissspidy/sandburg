/**
 * A full garbage collection in every isolate of a page: the page, its service worker, its workers
 * and theirs (a run's runtimes), over the DevTools Protocol, as DevTools' "collect garbage" does.
 *
 * Nothing the page runs sees it (no API, no global), only the pause. A worker blocked in
 * `Atomics.wait` (an idle WebAssembly thread) answers nothing until it wakes, so each isolate gets
 * `timeoutMs`, and the whole is bounded by the depth of the workers' nesting.
 */

/** What collectGarbage needs of a DevTools session (Playwright's CDPSession). */
export interface DevtoolsSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (params: never) => void): unknown;
  off(event: string, listener: (params: never) => void): unknown;
}

interface Attached {
  sessionId: string;
  targetInfo: { targetId: string; type: string };
}

type Send = (method: string, params?: object) => Promise<unknown>;
type On = (event: string, listener: (params: never) => void) => () => void;

/** Workers that attach after auto-attach is set are reported within this long (in one task, here). */
const ATTACH_WAIT_MS = 100;
/** Workers nest: the page's runtime, its threads' and child processes' runtimes, theirs. */
const MAX_DEPTH = 6;

/** Collects garbage in the page's isolates; resolves when each has answered or timed out. */
export async function collectGarbage(session: DevtoolsSession, timeoutMs: number): Promise<{ isolates: number }> {
  const offs: (() => void)[] = [];
  const on: On = (event, listener) => {
    session.on(event, listener);
    const off = () => session.off(event, listener);
    offs.push(off);
    return off;
  };
  const seen = new Set<string>();
  let isolates = 0;
  const visit = async (send: Send, listen: On, depth: number): Promise<void> => {
    const children: Attached[] = [];
    listen('Target.attachedToTarget', ((e: Attached) => children.push(e)));
    const gc = within(send('HeapProfiler.collectGarbage'), timeoutMs).then((ok) => ok && isolates++);
    if (depth < MAX_DEPTH) {
      // Already running workers are reported as soon as auto-attach is set.
      await within(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }), timeoutMs);
      await new Promise((r) => setTimeout(r, ATTACH_WAIT_MS));
    }
    await gc;
    await Promise.all(
      children.map((child) => {
        if (seen.has(child.targetInfo.targetId)) return Promise.resolve();
        seen.add(child.targetInfo.targetId);
        const [childSend, childOn] = relay(send, listen, child.sessionId, timeoutMs);
        return visit(childSend, childOn, depth + 1);
      }),
    );
  };
  try {
    await visit((m, p) => session.send(m, p), on, 0);
  } finally {
    for (const off of offs) off();
    await within(session.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }), timeoutMs);
  }
  return { isolates };
}

/** A child target's commands and events, through its parent's session (unflattened). */
function relay(send: Send, listen: On, sessionId: string, timeoutMs: number): [Send, On] {
  let id = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const listeners = new Map<string, ((params: never) => void)[]>();
  listen('Target.receivedMessageFromTarget', ((e: { sessionId: string; message: string }) => {
    if (e.sessionId !== sessionId) return;
    let m: { id?: number; method?: string; params?: never; result?: unknown; error?: unknown };
    try {
      m = JSON.parse(e.message);
    } catch {
      return;
    }
    if (m.id !== undefined) {
      pending.get(m.id)?.(m.error ? Promise.reject(new Error(String((m.error as { message?: string }).message))) : m.result);
      pending.delete(m.id);
    } else if (m.method) for (const l of listeners.get(m.method) ?? []) l(m.params as never);
  }));
  const childSend: Send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`${method}: no answer`));
      }, timeoutMs);
      pending.set(i, (r) => {
        clearTimeout(timer);
        Promise.resolve(r).then(resolve, reject);
      });
      send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: i, method, params }) }).catch((err) => {
        clearTimeout(timer);
        pending.delete(i);
        reject(err);
      });
    });
  const childOn: On = (event, listener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
    return () => list.splice(list.indexOf(listener), 1);
  };
  return [childSend, childOn];
}

/** Whether `p` settled successfully within `ms` (never rejects). */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
  ]).finally(() => clearTimeout(timer));
}
