/*
 * The service worker of an embedded Sandburg browser runtime (sandburg/browser-runtime). The embedding
 * page registers it from the runtime's directory, with a scope that holds the page:
 *
 *   navigator.serviceWorker.register('/sandburg/sw.js?app=/play/app', { scope: '/play/' })
 *
 * It does what the host server does in a Sandburg run, without one: it serves the runtime's own files
 * (runtime/ next to this file), compiles in the browser what the host would compile (compile.js,
 * esbuild's WebAssembly build), and gives the embedding page and the app the headers that make them
 * cross-origin isolated, which the runtime's shared memory needs. Then it does what the node runtime's
 * service worker does (sw-core.js): the app's requests go to the runtime running in the page.
 * Packages install from the npm registry in the page (pageInstall in index.js).
 *
 * Its query string configures it:
 *   app   the path the app lives at (default: <scope>app). The app sees itself at /.
 *   pass  comma-separated path prefixes that are the embedder's own files, fetched from the network
 *         (besides this directory's files). Other paths outside the app are the app's (absolute
 *         paths such as /_next/… or /src/main.tsx), as are all paths under it.
 */
const scope = new URL(self.registration.scope);
const site = new URL('./', self.location);
const config = new URL(self.location).searchParams;
const appPrefix = (config.get('app') ?? scope.pathname + 'app').replace(/\/+$/, '');
/**
 * This directory's own files: by name, not the directory as a prefix, which is / for a runtime
 * served at the site's root and would take every path of the app's for the embedder's.
 */
const OWN = ['index.js', 'sw.js', 'sw-core.js', 'compile.js', 'host.js', 'frame-guard.js', 'isolation.js', 'runtime/'].map((f) => site.pathname + f);
const pass = [...OWN, ...(config.get('pass') ?? '').split(',').filter(Boolean)];

const inApp = (url) => url.pathname === appPrefix || url.pathname.startsWith(appPrefix + '/');

/**
 * The embedder policy that makes pages cross-origin isolated. credentialless lets an app load
 * cross-origin images and scripts that do not opt in. WebKit (Safari, and every browser on iOS) does
 * not support it, only require-corp: there, cross-origin resources must send CORS or CORP headers.
 */
const ua = self.navigator.userAgent;
const COEP = /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua) ? 'require-corp' : 'credentialless';
const HEADERS = { 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': COEP, 'cross-origin-opener-policy': 'same-origin' };

/**
 * The runtime's own files, the same for every project (runtime/ next to this file). Each is
 * downloaded once and then answered from memory, as sw-core.js does for the runtime's worker: a run
 * starts dozens of workers, often while their parent is blocked.
 */
const RUNTIME_FILES = {
  'node-worker.js': 'text/javascript; charset=utf-8',
  'node-spare.js': 'text/javascript; charset=utf-8',
  'node-crypto.js': 'text/javascript; charset=utf-8',
  'node-wasi.js': 'text/javascript; charset=utf-8',
  'node-zlib.js': 'text/javascript; charset=utf-8',
  'compile-worker.js': 'text/javascript; charset=utf-8',
  'install-worker.js': 'text/javascript; charset=utf-8',
  'ws-shim.js': 'text/javascript; charset=utf-8',
  'sqlite3.js': 'text/javascript; charset=utf-8',
  'esbuild.wasm': 'application/wasm',
  'sqlite3.wasm': 'application/wasm',
};
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

const text = (body, status) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...HEADERS } });

/** What the host server would answer: the runtime's files and compiles; nothing else is kept. */
async function host(request, url) {
  const path = url.pathname.slice(url.pathname.indexOf('/__sandburg/'));
  // The runtime saves dev-server caches after a run; there is no host to keep them.
  if (request.method === 'POST' && path.startsWith('/__sandburg/dev-cache/')) return text('saved', 200);
  // What a run read (its notes, over HTTP without a file channel): no host builds from them.
  if (request.method === 'GET' && (/^\/__sandburg\/nm\/[0-9a-f]{24}\/read$/.test(path) || (/^\/__sandburg\/nm\/[0-9a-f]{24}\/[ft]\//.test(path) && url.search === '?used=1'))) {
    return new Response(null, { status: 204 });
  }
  const name = path.slice('/__sandburg/'.length);
  if (request.method === 'GET' && Object.hasOwn(RUNTIME_FILES, name)) return runtimeFile(name);
  if (request.method === 'POST' && path === '/__sandburg/compile') return compile(await request.arrayBuffer(), url);
  // The runtime asks for large code by digest before it sends it to compile: none is kept here.
  if (path.startsWith('/__sandburg/compiled/')) return text('not compiled before', 404);
  return text('not available in the browser runtime', 404);
}

/** Compiles code for the runtime, as the host would. */
async function compile(body, url) {
  const q = new URLSearchParams(url.search);
  try {
    const code = await self.sandburgCompile(new TextDecoder().decode(body), q.get('path') ?? '/unknown.js', q.get('kind') ?? 'cjs', q.get('async') === '1', new URL('runtime/esbuild.wasm', site).href);
    return new Response(code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  } catch (e) {
    return text(String(e?.message ?? e), 400);
  }
}

/** The embedding page, cross-origin isolated. */
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
    if (inApp(url)) return false;
    if (event.request.mode === 'navigate' && event.request.destination === 'document') {
      if (url.pathname.startsWith(scope.pathname)) event.respondWith(isolated(event.request));
      return true;
    }
    // The embedder's own files (its scripts, this runtime's files).
    if (pass.some((p) => url.pathname.startsWith(p))) return true;
    // Everything else belongs to the app.
    return false;
  },
  // The embedding page: a window in the scope, outside the app.
  isHost: (url) => url.pathname.startsWith(scope.pathname) && !inApp(url),
  appPath: (url) => (inApp(url) ? url.pathname.slice(appPrefix.length) || '/' : url.pathname) + url.search,
  // The reverse, for a redirect's Location: an absolute path of the app goes under the app's path.
  sitePath(location) {
    if (!location.startsWith('/') || location.startsWith('//') || location === appPrefix || location.startsWith(appPrefix + '/')) return location;
    return appPrefix + location;
  },
  // The app sees itself at /: its router reads location. Links that would leave the app's path (a
  // full navigation, which this worker would not see) come back under it.
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
