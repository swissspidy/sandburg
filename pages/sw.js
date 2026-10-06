/*
 * Service worker of the static demos. Each demo registers it with its own scope
 * (…/demos/<name>/). It answers what the host server answers in a Sandburg run, from the
 * answers recorded when the site was built (manifest.json, blobs/), and then does what the
 * node runtime's service worker does (sw-core.js): the app's requests go to the runtime
 * running in the page.
 *
 * - The demo page gets the headers that make it cross-origin isolated (static hosting
 *   cannot set them), which the runtime's shared memory needs.
 * - The app lives at …/demos/<name>/app/ (a path this worker controls) and sees itself at /.
 */
const scope = new URL(self.registration.scope);
const site = new URL('./', self.location);
const appPrefix = scope.pathname + 'app';

let manifest = null;
function entries() {
  manifest ??= fetch(new URL('manifest.json', site)).then((r) => r.json()).catch((e) => {
    manifest = null;
    throw e;
  });
  return manifest;
}

/** Shows a line in the demo's terminal. */
function tell(message) {
  self.clients.matchAll({ type: 'window' }).then((all) => all.forEach((c) => c.postMessage({ type: 'sandburg-demo', message })));
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The embedder policy that makes pages cross-origin isolated. credentialless lets an app load
 * cross-origin images and scripts that do not opt in. WebKit (Safari, and every browser on iOS) does
 * not support it, only require-corp: there, cross-origin resources must send CORS or CORP headers.
 */
const ua = self.navigator.userAgent;
const COEP = /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua) ? 'require-corp' : 'credentialless';
const HEADERS = { 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': COEP, 'cross-origin-opener-policy': 'same-origin' };

/**
 * The runtime's own files, the same for every project (runtime/ on the site): what a run that
 * installs its packages in the page (the generator) needs from its host. Each is downloaded once
 * and then answered from memory, as sw-core.js does for the runtime's worker: a run starts dozens
 * of workers, often while their parent is blocked.
 */
const RUNTIME_FILES = { 'node-worker.js': 'text/javascript; charset=utf-8', 'compile-worker.js': 'text/javascript; charset=utf-8', 'ws-shim.js': 'text/javascript; charset=utf-8', 'sqlite3.js': 'text/javascript; charset=utf-8', 'esbuild.wasm': 'application/wasm', 'sqlite3.wasm': 'application/wasm' };
const runtimeFiles = new Map();
async function runtimeFile(name) {
  let body = runtimeFiles.get(name);
  if (!body) {
    body = fetch(new URL(`runtime/${name}`, site)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`runtime/${name}: ${r.status}`))));
    runtimeFiles.set(name, body);
  }
  try {
    return new Response(await body, { headers: { 'content-type': RUNTIME_FILES[name], ...HEADERS } });
  } catch (e) {
    runtimeFiles.delete(name);
    return new Response(String(e?.message ?? e), { status: 502 });
  }
}

/** A recorded host answer: installed files, the runtime's worker, compiled modules, … */
async function host(request, url) {
  const path = url.pathname.slice(url.pathname.indexOf('/__sandburg/'));
  // The runtime saves dev-server caches after a run; a demo has nowhere to keep them.
  if (request.method === 'POST' && path.startsWith('/__sandburg/dev-cache/')) return new Response('saved');
  const name = path.slice('/__sandburg/'.length);
  if (request.method === 'GET' && Object.hasOwn(RUNTIME_FILES, name)) return runtimeFile(name);
  const body = request.method === 'POST' ? await request.arrayBuffer() : null;
  const key = body ? `POST ${path}?${new URLSearchParams(url.search)} ${await sha256(body)}` : path;
  const all = await entries();
  let entry = all[key];
  if (!entry && request.method === 'POST' && path === '/__sandburg/compile') {
    // The same code under another path (a timestamped file name): see scripts/pages/build.ts.
    const q = new URLSearchParams(url.search);
    const p = q.get('path') ?? '';
    entry = all[`POST /__sandburg/compile#${q.get('kind')}|${q.get('async') ?? ''}|${p.endsWith('x') ? 'x' : ''}|${/\.m[jt]s$/.test(p) ? 'm' : ''} ${key.slice(key.lastIndexOf(' ') + 1)}`];
  }
  if (!entry && request.method === 'POST' && path === '/__sandburg/compile') return compile(body, url);
  if (!entry) {
    const message = `not recorded: ${key.slice(0, 200)}`;
    console.warn(`[sandburg demo] ${message}`);
    tell(message);
    return new Response('not recorded when this demo was built', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const [blob, type, status] = entry;
  const res = await fetch(new URL(`blobs/${blob}.gz`, site));
  if (!res.ok) return new Response(`blob ${blob}: ${res.status}`, { status: 502 });
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip')), {
    status: status ?? 200,
    // The runtime's workers must be cross-origin isolated too, as the host server's answers are.
    headers: { 'content-type': type, ...HEADERS },
  });
}

/** Compiles what was not recorded (code that changes from run to run), as the host would. */
async function compile(body, url) {
  const q = new URLSearchParams(url.search);
  try {
    const code = await self.sandburgCompile(new TextDecoder().decode(body), q.get('path') ?? '/unknown.js', q.get('kind') ?? 'cjs', q.get('async') === '1', new URL('esbuild.wasm', site).href);
    tell(`compiled in the browser: ${q.get('path')}`);
    return new Response(code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  } catch (e) {
    return new Response(String(e?.message ?? e), { status: 400, headers: { 'content-type': 'text/plain' } });
  }
}

/** The demo page, cross-origin isolated. */
async function isolated(request) {
  const res = await fetch(request);
  const headers = new Headers(res.headers);
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', COEP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.sandburgHooks = {
  coep: COEP,
  fetch(event, url) {
    if (url.pathname.includes('/__sandburg/')) {
      event.respondWith(host(event.request, url));
      return true;
    }
    const inApp = url.pathname === appPrefix || url.pathname.startsWith(appPrefix + '/');
    if (inApp) return false;
    if (event.request.mode === 'navigate' && event.request.destination === 'document') {
      if (url.pathname.startsWith(scope.pathname)) event.respondWith(isolated(event.request));
      return true;
    }
    // The site's own files (the page's scripts, demo.json, blobs).
    if (url.pathname.startsWith(site.pathname)) return true;
    // Everything else belongs to the app (absolute paths such as /_next/… or /src/main.tsx).
    return false;
  },
  isHost: (url) => url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html',
  appPath(url) {
    const inApp = url.pathname === appPrefix || url.pathname.startsWith(appPrefix + '/');
    return (inApp ? url.pathname.slice(appPrefix.length) || '/' : url.pathname) + url.search;
  },
  // The reverse, for a redirect's Location: an absolute path of the app goes under the demo's path.
  sitePath(location) {
    if (!location.startsWith('/') || location.startsWith('//') || location === appPrefix || location.startsWith(appPrefix + '/')) return location;
    return appPrefix + location;
  },
  // The app sees itself at /: its router reads location. Links that would leave the demo's
  // path (a full navigation, which this worker would not see) come back under it.
  shim: `<script>(() => {
  const prefix = ${JSON.stringify(appPrefix)};
  if (location.pathname === prefix || location.pathname.startsWith(prefix + '/')) {
    history.replaceState(history.state, '', (location.pathname.slice(prefix.length) || '/') + location.search + location.hash);
  }
  addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (e.defaultPrevented || !a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const to = new URL(a.href, location.href);
    if (to.origin !== location.origin || to.pathname.startsWith(prefix) || (to.pathname === location.pathname && to.search === location.search)) return;
    e.preventDefault();
    location.assign(prefix + to.pathname + to.search + to.hash);
  });
})();</script>`,
};

importScripts('compile.js', 'sw-core.js');
