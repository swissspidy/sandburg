/**
 * Whether the app has rendered (the ready phase), asked in the app's frame: waitForRender
 * (orchestrator/app-ready.ts) runs it there serialized, and the host page calls it on the frame's
 * document (HostApi.rendered). Self-contained for that reason: no imports, no outside constants.
 *
 * Not the app yet: the browser's error page, and Nuxt's loading page. `selector` decides when given.
 * Else #root, #app or #__next has content, or the page shows text: in the document, or in an open
 * shadow root at any depth (an app that renders only into its custom element's shadow root, as Lit
 * apps do). An element with an empty shadow root, or one that holds only styles and slots, is not
 * rendered, and neither are a dev server's own overlays and tools (Vite's error overlay,
 * vite-plugin-checker's, Astro's toolbar, Next.js' portal). At most 2,000 elements are looked at, in
 * the document and its shadow roots together.
 */
export function appRendered(doc: Document, selector: string | null): boolean {
  if (doc.location.protocol === 'chrome-error:' || doc.documentElement.outerHTML.includes('__NUXT_LOADING__')) return false;
  if (selector) return !!doc.querySelector(selector);
  const root = doc.querySelector('#root, #app, #__next');
  // Rendered: elements, or text (an app may set only textContent).
  if (root) return root.childElementCount > 0 || (root.textContent ?? '').trim().length > 0;
  if (!doc.body) return false;
  if (doc.body.innerText.trim().length > 0) return true;
  // innerText leaves out shadow roots: look in them, breadth first, at most 2,000 elements in all.
  let budget = 2_000;
  const scopes: Node[] = [doc.body];
  for (let i = 0; i < scopes.length; i++) {
    const elements = doc.createTreeWalker(scopes[i], NodeFilter.SHOW_ELEMENT);
    for (let el = elements.nextNode() as Element | null; el; el = elements.nextNode() as Element | null) {
      if (budget-- <= 0) return false;
      const shadow = el.shadowRoot;
      // A dev server's own overlays and tools (Vite's error overlay, vite-plugin-checker's, Astro's toolbar) are not the app.
      if (!shadow || /^(vite-error-overlay|vite-plugin-checker-error-overlay|astro-dev-toolbar|astro-dev-overlay|nextjs-portal)$/.test(el.localName)) continue;
      const texts = doc.createTreeWalker(shadow, NodeFilter.SHOW_TEXT);
      for (let text = texts.nextNode(); text; text = texts.nextNode()) {
        // Shown, as innerText would count it: not hidden (display: none, `hidden`, visibility: hidden),
        // nor inside a style or script. Text right in the shadow root is shown as its host is.
        if (text.nodeValue?.trim() && (text.parentElement ?? el).checkVisibility({ visibilityProperty: true })) return true;
      }
      scopes.push(shadow);
    }
  }
  return false;
}
