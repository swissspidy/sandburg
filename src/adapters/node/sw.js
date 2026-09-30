/*
 * Service worker for the node runtime (ADR 0006).
 *
 * On a sandbox origin the host page lives at /__sandburg/ and everything else
 * belongs to the app. App requests are forwarded to the host page over a
 * MessagePort; the page hands them to the runtime worker, whose virtual HTTP
 * server answers. Responses stream back chunk by chunk (React Server
 * Components rely on streaming).
 *
 * Browsers stop idle service workers, which drops the port. On the next
 * request the worker asks the host page for a new one.
 */
let port = null;
let waiting = [];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'sandburg-port' && event.ports[0]) {
    port = event.ports[0];
    for (const resolve of waiting.splice(0)) resolve(port);
  }
});

async function getPort() {
  if (port) return port;
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    if (new URL(client.url).pathname.startsWith('/__sandburg/')) client.postMessage({ type: 'sandburg-need-port' });
  }
  return new Promise((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => reject(new Error('the runtime did not reconnect')), 10000);
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__sandburg/') || url.pathname === '/__sw__.js') return;
  // Top-level navigations are the host page; the app navigates inside its frame.
  if (event.request.mode === 'navigate' && event.request.destination === 'document') return;
  event.respondWith(forward(event.request, url));
});

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const SHIM = '<script src="/__sandburg/ws-shim.js"></script>';

/**
 * Inserts the WebSocket shim (ws-shim.js) into an HTML page, first thing in <head>, so it runs
 * before any app script. Streams through: only the bytes before <head …> are held back.
 */
function injectShim() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let done = false;
  const place = (text, final) => {
    const head = /<head\b[^>]*>/i.exec(text);
    if (head) return text.slice(0, head.index + head[0].length) + SHIM + text.slice(head.index + head[0].length);
    if (!final && text.length < 16384) return null;
    const html = /<html\b[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
    return html ? text.slice(0, html.index + html[0].length) + SHIM + text.slice(html.index + html[0].length) : SHIM + text;
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const out = place(pending, false);
      if (out !== null) {
        done = true;
        controller.enqueue(encoder.encode(out));
      }
    },
    flush(controller) {
      if (!done) controller.enqueue(encoder.encode(place(pending + decoder.decode(), true)));
    },
  });
}

async function forward(request, url) {
  let p;
  try {
    p = await getPort();
  } catch (e) {
    return new Response(String(e.message), { status: 503 });
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const { port1, port2 } = new MessageChannel();
  const headers = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  // Forbidden headers are not in request.headers; servers read Referer (SolidStart's single-flight actions).
  if (request.referrer && request.referrer !== 'about:client' && !headers.some(([n]) => n === 'referer')) headers.push(['referer', request.referrer]);
  p.postMessage({ type: 'request', method: request.method, url: url.pathname + url.search, headers, body }, body ? [port2, body] : [port2]);
  return new Promise((resolve) => {
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        port1.close();
      },
    });
    port1.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') {
        // Set-Cookie cannot be set from a service worker response; the page applies cookies itself.
        const h = new Headers();
        for (const [k, v] of m.headers) if (k.toLowerCase() !== 'set-cookie') h.append(k, v);
        // The host page may be cross-origin isolated (WebAssembly threads); app documents must be too.
        if (!h.has('cross-origin-embedder-policy')) h.set('cross-origin-embedder-policy', 'credentialless');
        if (!h.has('cross-origin-resource-policy')) h.set('cross-origin-resource-policy', 'same-origin');
        let body = NULL_BODY.has(m.status) || request.method === 'HEAD' ? null : stream;
        // App pages get the WebSocket shim (the host page relays their WebSockets to the runtime).
        if (body && request.mode === 'navigate' && /text\/html/i.test(h.get('content-type') ?? '')) {
          body = body.pipeThrough(injectShim());
          h.delete('content-length');
        }
        resolve(new Response(body, { status: m.status, statusText: m.statusText, headers: h }));
      } else if (m.type === 'chunk') {
        controller.enqueue(new Uint8Array(m.chunk));
      } else if (m.type === 'end') {
        try {
          controller.close();
        } catch {}
        port1.close();
      } else if (m.type === 'error') {
        resolve(new Response(m.message, { status: 502, headers: { 'content-type': 'text/plain' } }));
        try {
          controller.error(new Error(m.message));
        } catch {}
        port1.close();
      }
    };
  });
}
