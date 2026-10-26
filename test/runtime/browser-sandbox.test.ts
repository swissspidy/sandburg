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

/** The browser's processes: their pids by type. */
const processes = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo;

/** A process's status line (/proc/<pid>/status), e.g. Seccomp or NSpid. */
const status = (pid: number | 'self', key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];

/** How many pid namespaces a process is in (NSpid: its pid in each). */
const pidNamespaces = (pid: number) => status(pid, 'NSpid')!.split(/\s+/).length;

test('CI launches Chromium with its OS sandbox', { skip: !process.env.CI }, () => {
  assert.ok(sandboxed, 'SANDBURG_NO_BROWSER_SANDBOX=1 in CI: the runners can run the sandbox, and the tests should use it');
});

test(`each renderer runs ${sandboxed ? 'inside' : 'outside'} the OS sandbox`, { skip: process.platform !== 'linux' }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://a.localhost:${port}/`);
    const all = await processes();
    const browserPid = all.find((p) => p.type === 'browser')!.id;
    const pids = all.filter((p) => p.type === 'renderer').map((p) => p.id);
    assert.ok(pids.length > 0);
    // What this process has already (a container's seccomp profile, say): an unsandboxed renderer has the same.
    const inherited = status('self', 'Seccomp');
    for (const pid of pids) {
      // Seccomp 2: a seccomp-bpf filter (Chromium's sandbox policy, or one the container applies to all).
      assert.equal(status(pid, 'Seccomp'), sandboxed ? '2' : inherited, `renderer ${pid}: Seccomp`);
      // The sandbox's own: the renderer in pid namespaces of its own, under the browser's.
      if (sandboxed) assert.ok(pidNamespaces(pid) > pidNamespaces(browserPid), `renderer ${pid}: NSpid ${status(pid, 'NSpid')}`);
      else assert.equal(pidNamespaces(pid), pidNamespaces(browserPid), `renderer ${pid}: NSpid ${status(pid, 'NSpid')}`);
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
