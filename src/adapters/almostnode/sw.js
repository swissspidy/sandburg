/*
 * Sandburg service worker for the almostnode adapter.
 *
 * almostnode's worker forwards /__virtual__/<port>/ requests, and other
 * requests only when their Referer is a virtual URL. Modules loaded by an
 * absolute path (index.html's <script src="/src/main.tsx">) have a non-virtual
 * URL, so their relative imports (/src/App.tsx) would fall through to the host
 * server. On a sandbox origin the host page only ever requests "/",
 * /__sandburg/* and this worker, so every other same-origin subresource
 * belongs to the app: forward it to the dev server.
 *
 * This listener is registered before almostnode's, so it wins when it responds.
 */
const SANDBURG_APP_PORT = 5173;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') return;
  if (/^\/(__virtual__|__sandburg)\//.test(url.pathname) || url.pathname === '/__sw__.js') return;
  // handleVirtualRequest is defined by almostnode's worker (shared global scope).
  event.respondWith(handleVirtualRequest(event.request, SANDBURG_APP_PORT, url.pathname + url.search));
});

importScripts('/__sandburg/almostnode-sw.js');
