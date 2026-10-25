import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RendererMemory, matchRenderer, processMemory } from '../../src/orchestrator/renderer-memory.ts';

test("a page's renderer is the one renderer whose CPU time is the page's, within what it can have used since", () => {
  const renderers = [
    { pid: 10, cpuSeconds: 0.05 },
    { pid: 11, cpuSeconds: 3.31 },
    { pid: 12, cpuSeconds: 3.6 },
  ];
  assert.equal(matchRenderer(3.31, renderers, 0.001, 4), 11);
  // Read one tick short, or a little later on.
  assert.equal(matchRenderer(3.32, renderers, 0.001, 4), 11);
  assert.equal(matchRenderer(3.3, renderers, 0.001, 4), 11);
  // 0.1 s between the readings: 12 (0.29 s ahead) could be the page's renderer too, on 4 cores.
  assert.equal(matchRenderer(3.31, renderers, 0.1, 4), null);
  // None fits: a renderer cannot have gone back in time.
  assert.equal(matchRenderer(5, renderers, 0.001, 4), null);
  // Two tabs that loaded side by side.
  assert.equal(matchRenderer(0.3, [{ pid: 1, cpuSeconds: 0.3 }, { pid: 2, cpuSeconds: 0.3 }], 0.001, 4), null);
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
    4,
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
