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
/**
 * A static deployment (the demos, site/) sets these before it imports this file: its own answers to
 * host requests (fetch returns true when it responded), where its host page is, the app's path
 * prefix, markup to put before the WebSocket shim, and the embedder policy for app documents
 * (coep: require-corp where the browser has no credentialless).
 */
const hooks = self.sandburgHooks ?? {};

self.addEventListener('install', () => self.skipWaiting());
/**
 * The host page registers this worker as it loads, and is its client once it gives a port for an app
 * (it claims the page then): until an app starts, the page's own requests go to the host. The
 * workers the page starts are clients from their start either way (a dedicated worker is matched by
 * its own URL), and load the runtime through it (runtimeModule).
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'sandburg-port' && event.ports[0]) {
    event.waitUntil(self.clients.claim());
    port = event.ports[0];
    // Replies to requests sent on any port the page gave, the current one or an earlier one.
    port.onmessage = (e) => replies.get(e.data.id)?.(e.data);
    // The app is about to load: every app page loads the shim first thing (a script that blocks parsing).
    if (!hooks.fetch) void runtimeScript(new Request(WS_SHIM), WS_SHIM);
    for (const resolve of waiting.splice(0)) resolve(port);
  }
});

/**
 * The handlers of the requests in flight, by id: requests and their replies share the port the page
 * gave (one channel for all of them, not one per request).
 */
const replies = new Map();
let nextRequestId = 1;

async function getPort() {
  if (port) return port;
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    const at = new URL(client.url);
    if (hooks.isHost ? hooks.isHost(at) : at.pathname.startsWith('/__sandburg/')) client.postMessage({ type: 'sandburg-need-port' });
  }
  return new Promise((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => reject(new Error('the runtime did not reconnect')), 10000);
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    // The app's markup may name its own servers by an absolute URL built from Host (localhost:<port>,
    // as process.ts sends it): <link href="http://localhost:3000/style.css">. They are served here,
    // as ws-shim.js does for fetch and XMLHttpRequest; other origins go to the network.
    const port = localPort(url);
    if (port) event.respondWith(forward(event.request, url, `/__sandburg_backend/${port}${url.pathname}${url.search}`));
    return;
  }
  if (hooks.fetch && hooks.fetch(event, url)) return;
  if (url.pathname === '/__sandburg/node-worker.js' || url.pathname === WS_SHIM || RUNTIME_LIB.test(url.pathname)) {
    event.respondWith(runtimeScript(event.request, url.pathname));
    return;
  }
  if (RUNTIME_MODULE.test(url.pathname)) {
    event.respondWith(runtimeModule(event.request, url.pathname));
    return;
  }
  if (url.pathname.startsWith('/__sandburg/') || url.pathname === '/__sw__.js') return;
  // Top-level navigations are the host page; the app navigates inside its frame.
  if (event.request.mode === 'navigate' && event.request.destination === 'document') return;
  event.respondWith(forward(event.request, url));
});

/** The port of an http(s)://localhost:<port> URL (and 127.0.0.1, 0.0.0.0, [::1]), else null. */
function localPort(url) {
  if (!/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(url.hostname) || !/^https?:$/.test(url.protocol)) return null;
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/** The WebSocket shim each app page loads (SHIM below): fetched as the app starts, then answered from memory. */
const WS_SHIM = '/__sandburg/ws-shim.js';

/** The polyfills a runtime loads when a program first needs them (RUNTIME_LIBS in node-runtime/libs.ts). */
const RUNTIME_LIB = /^\/__sandburg\/node-[a-z]+\.js$/;

/**
 * The node runtime's script (and its libraries), downloaded once and then answered from memory. A
 * runtime starts one per thread and child process, often dozens at once, and a browser reads a
 * worker's script only as that worker loads: while a parent runtime is blocked (napi-rs WebAssembly
 * threads), downloads of a few MB each would hold every connection to the host, and the app's own
 * requests would wait behind them.
 */
const runtime = new Map();
async function runtimeScript(request, path) {
  let script = runtime.get(path);
  if (!script) {
    script = fetch(request).then(async (res) => {
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return { body: await res.arrayBuffer(), headers: [...res.headers] };
    });
    runtime.set(path, script);
  }
  try {
    const { body, headers } = await script;
    return new Response(body, { headers });
  } catch (e) {
    runtime.delete(path);
    return new Response(String(e?.message ?? e), { status: 502 });
  }
}

/**
 * The runtime's module (node-runtime/runtime-module.ts), by the digest of its text: answered from
 * Cache Storage, the one place Chromium keeps V8's code for a worker's script in this browser
 * context. The first runtime of the run compiles it; the code is kept beside the entry, and the
 * run's other runtimes (spares, threads, child processes) start from it.
 */
const RUNTIME_MODULE = /^\/__sandburg\/runtime\/[0-9a-f]{64}\.mjs$/;
const RUNTIME_CACHE = 'sandburg-runtime';
const modules = new Map();
async function runtimeModule(request, path) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    let res = await cache.match(path);
    if (!res) {
      let stored = modules.get(path);
      if (!stored) {
        // The module's text, whatever asked: a HEAD's empty body cached under the path would be the
        // module every later import got.
        stored = fetch(path).then(async (got) => {
          if (!got.ok) throw new Error(`${path}: ${got.status}`);
          await cache.put(path, got);
        });
        modules.set(path, stored);
      }
      await stored;
      res = (await cache.match(path)) ?? new Response(`${path}: not cached`, { status: 502 });
    }
    return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
  } catch (e) {
    modules.delete(path);
    return new Response(String(e?.message ?? e), { status: 502 });
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The app renders in the host page's frame (#app), on the host page's own origin; without Sandburg (the
 * Docker reference, a real browser) it is the top-level page. An app that refuses to be framed
 * (X-Frame-Options, or CSP's frame-ancestors: Helmet's defaults, Nuxt's error page) would show the
 * browser's error page there instead. forward() drops X-Frame-Options, and frame-ancestors becomes
 * 'self' (the host page's origin) in each policy of each CSP header, its other directives unchanged.
 * An app that said no with X-Frame-Options alone gets frame-ancestors 'self' in its place, so other
 * pages (another run's, on another *.sandburg.localhost origin) still cannot frame it.
 */
const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only']);
const FRAME_ANCESTORS = /(^|[;,])(\s*)frame-ancestors(?=[\s;,]|$)[^;,]*/gi;
function framedBySelf(policy) {
  return policy.replace(FRAME_ANCESTORS, "$1$2frame-ancestors 'self'");
}
// Only ASCII whitespace separates a directive, as CSP parses it: a frame-ancestors after another space
// (a non-breaking one) is ignored by the browser, so it does not stand in for X-Frame-Options.
const HAS_FRAME_ANCESTORS = /(^|[;,])[\t\n\f\r ]*frame-ancestors(?=[\t\n\f\r ;,]|$)/i;

const SHIM = (hooks.shim ?? '') + `<script src="${WS_SHIM}"></script>`;

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

/**
 * Forwards an app request to the runtime. `path` is where it goes when it is not the app's own URL
 * (a server's localhost URL, served by its port): the browser treats its answer as cross-origin.
 */
async function forward(request, url, path) {
  let p;
  try {
    p = await getPort();
  } catch (e) {
    return new Response(String(e.message), { status: 503 });
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const id = nextRequestId++;
  const headers = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  // Forbidden headers are not in request.headers; servers read Referer (SolidStart's single-flight actions).
  // On a static deployment, the app's own path (without the site's prefix), as the app sees itself.
  if (request.referrer && request.referrer !== 'about:client' && !headers.some(([n]) => n === 'referer')) {
    const referrer = new URL(request.referrer);
    headers.push(['referer', hooks.appPath && referrer.origin === self.location.origin ? referrer.origin + hooks.appPath(referrer) : request.referrer]);
  }
  p.postMessage({ type: 'request', id, method: request.method, url: path ?? (hooks.appPath ? hooks.appPath(url) : url.pathname + url.search), headers, body }, body ? [body] : []);
  return new Promise((resolve) => {
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        replies.delete(id);
      },
    });
    replies.set(id, (m) => {
      if (m.type === 'start' || m.type === 'full') {
        // Set-Cookie cannot be set from a service worker response; the page applies cookies itself.
        // The app may be framed by the host page whatever it says (framedBySelf).
        const h = new Headers();
        let refusesFraming = false;
        let enforcesAncestors = false;
        for (const [k, v] of m.headers) {
          const name = k.toLowerCase();
          if (name === 'x-frame-options') refusesFraming = true;
          if (name === 'content-security-policy' && HAS_FRAME_ANCESTORS.test(v)) enforcesAncestors = true;
          if (name === 'set-cookie' || name === 'x-frame-options') continue;
          h.append(k, CSP_HEADERS.has(name) ? framedBySelf(v) : v);
        }
        // X-Frame-Options as frame-ancestors 'self', in a policy of its own (the app's others are unchanged).
        if (refusesFraming && !enforcesAncestors) h.append('content-security-policy', "frame-ancestors 'self'");
        // The host page may be cross-origin isolated (WebAssembly threads); app documents must be too.
        if (!h.has('cross-origin-embedder-policy')) h.set('cross-origin-embedder-policy', hooks.coep ?? 'credentialless');
        if (path) {
          // On the developer's machine the page and this server share an origin: the page may use its
          // answers as its own (a module script, a font), where a browser checks them as cross-origin.
          h.set('cross-origin-resource-policy', 'cross-origin');
          if (request.mode === 'cors') {
            h.set('access-control-allow-origin', self.location.origin);
            h.set('access-control-allow-credentials', 'true');
          }
        } else if (!h.has('cross-origin-resource-policy')) h.set('cross-origin-resource-policy', 'same-origin');
        // A redirect to one of the app's own paths (/login) stays where the deployment serves the app.
        // (A server's localhost URL resolves it against its own origin, which comes back here.)
        if (hooks.sitePath && !path && h.has('location')) h.set('location', hooks.sitePath(h.get('location')));
        let body = NULL_BODY.has(m.status) || request.method === 'HEAD' ? null : stream;
        // A whole response (the runtime had it all in one task): no more messages for it.
        if (m.type === 'full') {
          replies.delete(id);
          if (body && m.body.byteLength) controller.enqueue(new Uint8Array(m.body));
          controller.close();
        }
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
        replies.delete(id);
      } else if (m.type === 'error') {
        // A localhost URL that no server answers (nothing listens there) fails as a refused connection
        // would: a program's fetch() in the runtime sees ECONNREFUSED.
        resolve(path ? Response.error() : new Response(m.message, { status: 502, headers: { 'content-type': 'text/plain' } }));
        try {
          controller.error(new Error(m.message));
        } catch {}
        replies.delete(id);
      }
    });
  });
}
