import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RendererMemory, matchRenderer, processMemory } from '../../src/orchestrator/renderer-memory.ts';

test("a page's renderer is the one renderer whose CPU time, read before and after the page's, brackets it", () => {
  const before = [
    { pid: 10, cpuSeconds: 0.05 },
    { pid: 11, cpuSeconds: 3.3 },
    { pid: 12, cpuSeconds: 3.5 },
  ];
  const after = [
    { pid: 10, cpuSeconds: 0.05 },
    { pid: 11, cpuSeconds: 3.32 },
    { pid: 12, cpuSeconds: 3.9 },
  ];
  assert.equal(matchRenderer(3.31, before, after), 11);
  // Read a tick apart.
  assert.equal(matchRenderer(3.31, [{ pid: 11, cpuSeconds: 3.32 }], [{ pid: 11, cpuSeconds: 3.32 }]), 11);
  // 12 was busy in between: it fits 3.6 s, and only it.
  assert.equal(matchRenderer(3.6, before, after), 12);
  // Both busy, both passing 3.45 s in between: either could be the page's.
  assert.equal(matchRenderer(3.45, [{ pid: 11, cpuSeconds: 3.4 }, { pid: 12, cpuSeconds: 3.44 }], [{ pid: 11, cpuSeconds: 3.5 }, { pid: 12, cpuSeconds: 3.9 }]), null);
  // None fits; one that started in between is not taken.
  assert.equal(matchRenderer(5, before, after), null);
  assert.equal(matchRenderer(0.2, before, [...after, { pid: 13, cpuSeconds: 0.2 }]), null);
  // Two tabs that loaded side by side.
  const idle = [
    { pid: 1, cpuSeconds: 0.3 },
    { pid: 2, cpuSeconds: 0.3 },
  ];
  assert.equal(matchRenderer(0.3, idle, idle), null);
});

test('RendererMemory looks again until one renderer fits, then reads only that one, until the run is over', async () => {
  const cpu = new Map([
    [1, 0.3],
    [2, 0.3],
  ]);
  let pageCpu = 0.3;
  const read: number[] = [];
  let released = 0;
  const memory = new RendererMemory(
    {
      pageCpu: async () => pageCpu,
      renderers: async () => [...cpu].map(([pid, cpuSeconds]) => ({ pid, cpuSeconds })),
      memory: (pid) => (read.push(pid), pid * 100),
      release: () => released++,
    },
  );
  assert.equal(await memory.locate(), false, 'two renderers fit');
  assert.equal(memory.used(), null);
  // The page's app starts: its renderer's time parts from the other's.
  cpu.set(2, 2.5);
  pageCpu = 2.5;
  assert.equal(await memory.locate(), true);
  assert.equal(released, 1, "the page's DevTools session is let go once found");
  assert.equal(memory.used(), 200);
  assert.equal(memory.peak, 200);
  assert.deepEqual(read, [2]);
  memory.stop();
  assert.equal(memory.used(), null, 'not read after the run (its pid may be reused)');
  assert.equal(await memory.locate(), true);
});

test('RendererMemory keeps the renderers that fitted every look: identical tabs are told apart over time', async () => {
  // Three busy renderers of apps that started together. No single look tells the page's (2) apart.
  const looks = [
    { page: 1.0, before: [[1, 0.98], [2, 0.99], [3, 1.5]], after: [[1, 1.05], [2, 1.06], [3, 1.6]] },
    { page: 2.0, before: [[1, 2.5], [2, 1.99], [3, 1.98]], after: [[1, 2.6], [2, 2.02], [3, 2.05]] },
  ];
  let look = 0;
  let phase: 'before' | 'after' = 'before';
  const memory = new RendererMemory({
    pageCpu: async () => looks[look].page,
    renderers: async () => {
      const at = looks[look][phase];
      phase = phase === 'before' ? 'after' : 'before';
      return at.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds }));
    },
    memory: (pid) => pid * 100,
  });
  assert.equal(matchRenderer(looks[0].page, looks[0].before.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds })), looks[0].after.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds }))), null);
  assert.equal(matchRenderer(looks[1].page, looks[1].before.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds })), looks[1].after.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds }))), null);
  assert.equal(await memory.locate(), false, '1 and 2 fit');
  look = 1;
  assert.equal(await memory.locate(), true, '2 and 3 fit now: only 2 fitted both');
  assert.equal(memory.used(), 200);
});

test('RendererMemory reads nothing when the page or the browser cannot say', async () => {
  const memory = new RendererMemory({
    pageCpu: async () => {
      throw new Error('target closed');
    },
    renderers: async () => [],
  });
  assert.equal(await memory.locate(), false);
  assert.equal(memory.used(), null);
  assert.equal(memory.peak, 0);
});

test("a process's memory is its resident anonymous and shared memory, null for none", { skip: process.platform !== 'linux' }, () => {
  const bytes = processMemory(process.pid);
  assert.ok(bytes !== null && bytes > 10 * 2 ** 20 && bytes < process.memoryUsage().rss * 2, String(bytes));
  assert.equal(processMemory(2 ** 30), null);
});
