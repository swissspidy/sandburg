/**
 * Finding each page's renderer (src/orchestrator/renderer-memory.ts) as a session does, with
 * Chromium as a session launches it (inside its OS sandbox unless SANDBURG_NO_BROWSER_SANDBOX=1):
 * pages that look for their renderers side by side on a machine whose cores are all busy each find
 * their own, or none, never another page's.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { chromium, type Browser, type CDPSession } from 'playwright-core';
import { browserSandbox, launchOptions } from '../../src/orchestrator/launch.ts';
import { pageRendererMemory } from '../../src/orchestrator/renderer-memory.ts';

const PAGES = 8;
/** What page i holds: (i + 1) of these, far more apart than a renderer's own memory varies. */
const STEP = 48 * 2 ** 20;

let browser: Browser;
let cdp: Promise<CDPSession> | null = null;
before(async () => {
  browser = await chromium.launch({ ...launchOptions({}), proxy: undefined });
});
after(() => browser?.close());

/** Keeps every core busy until stopped. */
function load(): () => Promise<void> {
  const spin = 'const { workerData } = require("node:worker_threads"); const until = Date.now() + workerData; while (Date.now() < until);';
  const workers = Array.from({ length: availableParallelism() }, () => new Worker(spin, { eval: true, workerData: 60_000 }));
  return async () => void (await Promise.all(workers.map((w) => w.terminate())));
}

test(`pages that look for their renderers at once, on busy cores, each find their own (${browserSandbox({}) ? 'inside' : 'outside'} the OS sandbox)`, { skip: process.platform !== 'linux', timeout: 120_000 }, async () => {
  const pages = await Promise.all(
    Array.from({ length: PAGES }, async (_, i) => {
      const page = await (await browser.newContext()).newPage();
      await page.setContent('<p>page</p>');
      // (Returning nothing: the array itself would be serialized back, a copy of it left in the renderer.)
      await page.evaluate((bytes) => void ((window as unknown as { held: Uint8Array }).held = new Uint8Array(bytes).fill(1)), (i + 1) * STEP);
      return page;
    }),
  );
  const stop = load();
  try {
    // As a session looks (RENDERER_LOCATE_MS apart, from its start phase), the pages starting a little apart.
    const found = await Promise.all(
      pages.map(async (page, i) => {
        await new Promise((r) => setTimeout(r, i * 60));
        const memory = pageRendererMemory(page, () => (cdp ??= browser.newBrowserCDPSession()), browserSandbox({}))!;
        const deadline = performance.now() + 30_000;
        while (!(await memory.locate()) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 250));
        return memory.used();
      }),
    );
    for (const [i, bytes] of found.entries()) {
      if (bytes === null) continue;
      // Its own renderer holds what the page holds and a renderer's own (some tens of MB); another page's differs by STEP or more.
      const held = (i + 1) * STEP;
      assert.ok(bytes >= held && bytes < held + STEP * 0.8, `page ${i}: holds ${held / 2 ** 20} MB, its renderer was read as ${Math.round(bytes / 2 ** 20)} MB (${found.map((b) => (b === null ? null : Math.round(b / 2 ** 20)))})`);
    }
    // Pages find theirs (8 of 8 here; one that cannot be told apart reports none, not another's).
    assert.ok(found.filter((b) => b !== null).length >= PAGES / 2, `found: ${found.map((b) => (b === null ? null : Math.round(b / 2 ** 20)))}`);
  } finally {
    await stop();
    await Promise.all(pages.map((p) => p.context().close()));
  }
});
