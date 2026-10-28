/** When the functional checks start (src/host/settle.ts): the framework's word, else the app's servers being quiet. In Chromium. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { inputSafe, quiet } from '../../src/host/settle.ts';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
});
after(() => browser.close());

/** A new page each time (setContent keeps the document object, and what was set on it). */
const load = async (html: string) => {
  await page?.close();
  page = await browser.newPage();
  await page.setContent(html);
};
const safe = () => page.evaluate(`(${inputSafe.toString()})(window)`) as Promise<boolean | undefined>;

test('quiet: no request for a moment, and none young in flight', () => {
  assert.equal(quiet({ inflight: 0, idleMs: 0, sinceRequestMs: 150, newestInflightMs: null }, 100, 1000), true);
  assert.equal(quiet({ inflight: 0, idleMs: 0, sinceRequestMs: 50, newestInflightMs: null }, 100, 1000), false);
  // Modules still loading.
  assert.equal(quiet({ inflight: 3, idleMs: 0, sinceRequestMs: 300, newestInflightMs: 300 }, 100, 1000), false);
  // An event stream open for seconds does not count.
  assert.equal(quiet({ inflight: 1, idleMs: 0, sinceRequestMs: 4000, newestInflightMs: 4000 }, 100, 1000), true);
});

test('a page without a framework that says: undefined (the servers decide)', async () => {
  await load('<div id="app"><button>Clicked 0 times</button></div>');
  assert.equal(await safe(), undefined);
});

test('Solid: not until it has claimed every server-rendered element (its replay of earlier events reaches no handler)', async () => {
  await load('<script>window._$HY = { events: [], completed: new WeakSet(), r: {} }</script><main data-hk="0"><input data-hk="00"></main>');
  assert.equal(await safe(), false);
  // The page's own elements are claimed as it hydrates; a lazy route's later.
  await page.evaluate(() => (window as unknown as { _$HY: { completed: WeakSet<Element> } })._$HY.completed.add(document.querySelector('main')!));
  assert.equal(await safe(), false);
  await page.evaluate(() => (window as unknown as { _$HY: { completed: WeakSet<Element> } })._$HY.completed.add(document.querySelector('input')!));
  assert.equal(await safe(), true);
  // Solid dropped its claims (done, after replaying an event): it says nothing, and the servers decide.
  await load('<script>window._$HY = { events: null, completed: null, r: {}, done: true }</script><main data-hk="0"></main>');
  assert.equal(await safe(), undefined);
});

test("Solid: `done` alone is not hydrated (an event on a claimed element sets it while a lazy route's are not claimed); every element is looked at", async () => {
  await load('<script>window._$HY = { events: [], completed: new WeakSet(), r: {}, done: true }</script><main data-hk="0"></main><section data-hk="1"></section>');
  await page.evaluate(() => (window as unknown as { _$HY: { completed: WeakSet<Element> } })._$HY.completed.add(document.querySelector('main')!));
  assert.equal(await safe(), false);
  await page.evaluate(() => (window as unknown as { _$HY: { completed: WeakSet<Element> } })._$HY.completed.add(document.querySelector('section')!));
  assert.equal(await safe(), true);
  // 600 claimed elements, then a lazy route's, not claimed yet.
  await load('<script>window._$HY = { events: [], completed: new WeakSet(), r: {} }</script><main></main>');
  await page.evaluate(() => {
    const hy = (window as unknown as { _$HY: { completed: WeakSet<Element> } })._$HY;
    const main = document.querySelector('main')!;
    for (let i = 0; i < 600; i++) hy.completed.add(main.appendChild(Object.assign(document.createElement('p'), { textContent: String(i) })));
    for (const p of main.querySelectorAll('p')) p.setAttribute('data-hk', p.textContent ?? '');
    main.appendChild(document.createElement('section')).setAttribute('data-hk', 'lazy');
  });
  assert.equal(await safe(), false);
});

test('React: safe once its root exists (it replays clicks on what it has not hydrated)', async () => {
  await load('<div id="root"><button>0</button></div>');
  assert.equal(await safe(), undefined);
  await page.evaluate(() => Object.assign(document.getElementById('root')!, { '__reactContainer$abc': {} }));
  assert.equal(await safe(), true);
  await load('<p>hi</p>');
  await page.evaluate(() => Object.assign(document, { '__reactContainer$x': {} }));
  assert.equal(await safe(), true);
});

test('Nuxt: not until its page has hydrated, whatever the servers do', async () => {
  await load('<div id="__nuxt"><button>Clicked 0 times</button></div>');
  assert.equal(await safe(), false);
  await page.evaluate(() => Object.assign(document.getElementById('__nuxt')!, { __vue_app__: { config: { globalProperties: { $nuxt: { isHydrating: true } } } } }));
  assert.equal(await safe(), false);
  await page.evaluate(() => ((document.getElementById('__nuxt') as unknown as { __vue_app__: { config: { globalProperties: { $nuxt: { isHydrating: boolean } } } } }).__vue_app__.config.globalProperties.$nuxt.isHydrating = false));
  assert.equal(await safe(), true);
});

test('SvelteKit: not until Svelte has hydrated its page, whatever the servers do', async () => {
  await load('<script>window.__sveltekit_dev = { base: "" }</script><div style="display: contents"><main><button>Clicked 0 times</button></main></div>');
  assert.equal(await safe(), false);
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('main, button')) Object.assign(e, { __svelte_meta: { loc: { file: 'src/routes/+page.svelte' } } });
  });
  assert.equal(await safe(), true);
  // A Svelte app without SvelteKit: the servers decide, as before.
  await load('<div id="app"><button>Clicked 0 times</button></div>');
  assert.equal(await safe(), undefined);
  // A production build (its globals are __sveltekit_<hash>, its elements have no __svelte_meta): the servers decide.
  await load('<script>window.__sveltekit_1x2y3z = { base: "" }</script><main><button>Clicked 0 times</button></main>');
  assert.equal(await safe(), undefined);
});

test("a getter that throws in the app's window is undefined, not an error", async () => {
  await load('<p>hi</p>');
  await page.evaluate(() => Object.defineProperty(window, '_$HY', { get() { throw new Error('no'); } }));
  assert.equal(await safe(), undefined);
});
