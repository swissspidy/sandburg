/**
 * Chromium as a session launches it (src/orchestrator/launch.ts): its renderers inside the OS sandbox
 * (seccomp-bpf, on Linux), unless turned off with SANDBURG_NO_BROWSER_SANDBOX=1, and a frame of
 * another site in a renderer of its own (--site-per-process).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type CDPSession } from 'playwright-core';
import { browserSandbox, launchOptions } from '../../src/orchestrator/launch.ts';

const sandboxed = browserSandbox({});
let browser: Browser;
let cdp: CDPSession;
let server: Server;
let port: number;

before(async () => {
  // A page on one site with a frame of another (a.localhost and b.localhost are two sites).
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? `<iframe src="http://b.localhost:${port}/frame"></iframe>` : '<p>frame</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // Without the egress backstop (the dead proxy): this test's server is on loopback, outside a sandbox origin.
  browser = await chromium.launch({ ...launchOptions({}), proxy: undefined });
  cdp = await browser.newBrowserCDPSession();
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** The pids of the browser's renderer processes. */
const renderers = async () => {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
};

test('CI launches Chromium with its OS sandbox', { skip: !process.env.CI }, () => {
  assert.ok(sandboxed, 'SANDBURG_NO_BROWSER_SANDBOX=1 in CI: the runners can run the sandbox, and the tests should use it');
});

test(`each renderer runs ${sandboxed ? 'inside' : 'outside'} the OS sandbox (seccomp filter ${sandboxed ? 'on' : 'off'})`, { skip: process.platform !== 'linux' }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://a.localhost:${port}/`);
    const pids = await renderers();
    assert.ok(pids.length > 0);
    for (const pid of pids) {
      const seccomp = /^Seccomp:\s*(\d)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
      // 2: a seccomp-bpf filter (Chromium's sandbox policy); 0: none.
      assert.equal(seccomp, sandboxed ? '2' : '0', `renderer ${pid}`);
    }
  } finally {
    await page.close();
  }
});

test("a frame of another site runs in a renderer of its own, not in its page's", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://a.localhost:${port}/`);
    await page.frames()[1]?.waitForLoadState();
    assert.equal(await page.frames()[1]?.textContent('p'), 'frame');
    // An out-of-process frame is a target of its own; one in its page's renderer is not.
    const { targetInfos } = await cdp.send('Target.getTargets');
    assert.ok(targetInfos.some((t) => t.type === 'iframe' && t.url === `http://b.localhost:${port}/frame`), JSON.stringify(targetInfos.map((t) => `${t.type} ${t.url}`)));
  } finally {
    await page.close();
  }
});
