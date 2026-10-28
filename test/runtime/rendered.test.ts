/** When the app has rendered (src/host/rendered.ts), in its own document and in its shadow roots. In Chromium. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { appRendered } from '../../src/host/rendered.ts';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
});
after(() => browser.close());

/** The page's body, then whether it counts as rendered (as waitForRender asks it, serialized). A new page each time: setContent keeps the document, and its custom elements. */
async function rendered(body: string, script = '', selector: string | null = null): Promise<boolean> {
  await page?.close();
  page = await browser.newPage();
  await page.setContent(`<body>${body}<script>${script}</script></body>`);
  return page.evaluate(`(${appRendered.toString()})(document, ${JSON.stringify(selector)})`) as Promise<boolean>;
}

/** Defines <name> with an open shadow root holding `html`. */
const element = (name: string, html: string) =>
  `customElements.define('${name}', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(html)}; } });`;

test('text or elements in the document, as before', async () => {
  assert.equal(await rendered('<p>Hello</p>'), true);
  assert.equal(await rendered('<div id="app"><span></span></div>'), true);
  assert.equal(await rendered('<div id="root"></div>'), false);
  assert.equal(await rendered(''), false);
  assert.equal(await rendered('<div id="__nuxt">__NUXT_LOADING__</div>'), false);
  assert.equal(await rendered('<p>Hello</p>', '', '#missing'), false);
  assert.equal(await rendered('<p id="here"></p>', '', '#here'), true);
});

test('an app that renders only into its custom element\'s shadow root (Lit) has rendered', async () => {
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '<style>h1 { color: red }</style><main><h1>Music Tracker</h1></main>')), true);
});

test('text in a shadow root inside a shadow root counts too', async () => {
  const script = element('app-root', '<main><feature-card></feature-card></main>') + element('feature-card', '<section><p>Count: 0</p></section>');
  assert.equal(await rendered('<app-root></app-root>', script), true);
});

test('empty custom elements are not rendered: no shadow root, an empty one, or only styles, slots and hidden text', async () => {
  assert.equal(await rendered('<app-root></app-root>'), false);
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '')), false);
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '<style>:host { display: block }</style><slot></slot>')), false);
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '<div hidden>Loading the app</div><template>Later</template>')), false);
  // A closed shadow root cannot be read: not rendered (the app may set readySelector).
  const closed = `customElements.define('app-root', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<h1>Hi</h1>'; } });`;
  assert.equal(await rendered('<app-root></app-root>', closed), false);
});

test('shadow text counts only where it is shown, as innerText would count it', async () => {
  // Text right in the shadow root (Lit renders so) is shown as its host is.
  assert.equal(await rendered('<app-root></app-root>', element('app-root', 'Music Tracker')), true);
  assert.equal(await rendered('<app-root hidden></app-root>', element('app-root', 'Music Tracker')), false);
  assert.equal(await rendered('<app-root style="visibility: hidden"></app-root>', element('app-root', '<h1>Music Tracker</h1>')), false);
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '<h1 style="visibility: hidden">Music Tracker</h1>')), false);
  // Text inside a style is not shown.
  assert.equal(await rendered('<app-root></app-root>', element('app-root', '<style>h1 { color: red }</style>')), false);
});

test("a dev server's overlays and tools are not the app: Vite's and vite-plugin-checker's error overlays, Astro's toolbar", async () => {
  assert.equal(await rendered('<vite-error-overlay></vite-error-overlay>', element('vite-error-overlay', '<div class="message">Internal server error</div>')), false);
  assert.equal(await rendered('<vite-plugin-checker-error-overlay></vite-plugin-checker-error-overlay>', element('vite-plugin-checker-error-overlay', '<pre>TS2322</pre>')), false);
  assert.equal(await rendered('<astro-dev-toolbar></astro-dev-toolbar>', element('astro-dev-toolbar', '<button>Menu</button>')), false);
});

test('the search is bounded: the first 2,000 elements are looked at, not one more', async () => {
  // <late-text> is element n + 1 of the body.
  const after = (n: number) => `${element('late-text', '<p>Late</p>')} for (let i = 0; i < ${n}; i++) document.body.prepend(document.createElement('span'));`;
  assert.equal(await rendered('<late-text></late-text>', after(1_999)), true);
  assert.equal(await rendered('<late-text></late-text>', after(2_000)), false);
});
