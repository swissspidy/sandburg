import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectGarbage } from '../../src/orchestrator/collect-garbage.ts';

/**
 * A page's DevTools session: the page, a service worker, a runtime worker with a thread of its own,
 * and a thread blocked in Atomics.wait (it answers nothing). Child targets are reached unflattened,
 * through Target.sendMessageToTarget, as Chromium does.
 */
function fakePage() {
  const page = new EventEmitter();
  const collected: string[] = [];
  const tree: Record<string, string[]> = { page: ['sw', 'runtime', 'blocked'], runtime: ['thread'], sw: [], thread: [], blocked: [] };
  // A target handles a command and answers (or not, blocked) on its channel to its parent;
  // Target.sendMessageToTarget passes a command on to a child, whose messages come back wrapped.
  const deliver = (target: string, m: { id: number; method: string; params: Record<string, unknown> }, out: (message: object) => void) => {
    if (target === 'blocked') return;
    if (m.method === 'Target.sendMessageToTarget') {
      const child = String(m.params.sessionId).slice(2);
      const inner = JSON.parse(String(m.params.message));
      deliver(child, inner, (message) => out({ method: 'Target.receivedMessageFromTarget', params: { sessionId: m.params.sessionId, message: JSON.stringify(message) } }));
    } else if (m.method === 'HeapProfiler.collectGarbage') collected.push(target);
    out({ id: m.id, result: {} });
    if (m.method === 'Target.setAutoAttach' && m.params.autoAttach)
      for (const child of tree[target]) out({ method: 'Target.attachedToTarget', params: { sessionId: `s-${child}`, targetInfo: { targetId: child, type: 'worker' } } });
  };
  let ids = 0;
  const session = {
    on: (e: string, l: (p: never) => void) => page.on(e, l as (...a: unknown[]) => void),
    off: (e: string, l: (p: never) => void) => page.off(e, l as (...a: unknown[]) => void),
    send(method: string, params: Record<string, unknown> = {}) {
      const id = ++ids;
      return new Promise((resolve) =>
        deliver('page', { id, method, params }, (message: { id?: number; method?: string; params?: unknown }) =>
          setTimeout(() => (message.id === id ? resolve({}) : message.method && page.emit(message.method, message.params)), 5),
        ),
      );
    },
  };
  return { session, collected, listeners: () => page.eventNames().reduce((n, e) => n + page.listenerCount(e), 0) };
}

test('garbage is collected in every isolate of the page, a blocked worker given up on after the timeout', async () => {
  const { session, collected, listeners } = fakePage();
  const started = performance.now();
  const { isolates } = await collectGarbage(session, 300);
  assert.deepEqual(collected.sort(), ['page', 'runtime', 'sw', 'thread']);
  assert.equal(isolates, 4);
  assert.ok(performance.now() - started < 2000, 'bounded by the timeout, not the blocked worker');
  assert.equal(listeners(), 0, 'no listener left on the session');
});
