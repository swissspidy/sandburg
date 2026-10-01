/*
 * Runs one demo: the same lifecycle a Sandburg run drives through window.__sandburg (mount,
 * install, start, ready), with the host's answers replayed by sw.js.
 */
const name = document.documentElement.dataset.demo;
const scope = new URL('./', location.href);
const site = new URL('../../', location.href);
const sw = { url: new URL('sw.js', site).pathname, scope: scope.pathname };
Object.assign(window, { __sandburgBase: scope.pathname + '__sandburg', __sandburgServiceWorker: sw });

const $ = (id) => document.getElementById(id);
const terminal = $('terminal');
const started = performance.now();
let timer = 0;

function print(text, kind = 'out') {
  const atEnd = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 4;
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text.replace(/\x1b\[[0-9;]*m/g, '');
  terminal.append(line);
  if (atEnd) terminal.scrollTop = terminal.scrollHeight;
}

function step(id, state, detail = '') {
  const el = document.querySelector(`[data-step="${id}"]`);
  if (!el) return;
  el.dataset.state = state;
  el.querySelector('.time').textContent = detail;
}

function fail(message) {
  clearInterval(timer);
  $('status').textContent = 'Failed';
  $('status').dataset.state = 'failed';
  print(message, 'err');
  $('overlay').hidden = false;
  $('overlay').querySelector('p').textContent = message;
}

async function phase(id, fn) {
  const t = performance.now();
  step(id, 'active');
  const result = await fn();
  if (result && result.ok === false) {
    step(id, 'failed');
    throw new Error(result.error.message);
  }
  step(id, 'done', `${((performance.now() - t) / 1000).toFixed(1)} s`);
  return result?.value;
}

async function boot() {
  if (!('serviceWorker' in navigator)) return fail('This demo needs service workers (not available in this browser or in private windows of some browsers).');
  const reloaded = `sandburg-reloaded:${name}`;
  if (!crossOriginIsolated) {
    // First visit: the service worker gives this page the headers for shared memory.
    await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
    await navigator.serviceWorker.ready;
    if (sessionStorage.getItem(reloaded)) {
      sessionStorage.removeItem(reloaded);
      return fail('The page could not be made cross-origin isolated. Reload it normally (not a hard reload).');
    }
    sessionStorage.setItem(reloaded, '1');
    location.reload();
    return;
  }
  sessionStorage.removeItem(reloaded);

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const m = typeof args[0] === 'string' && /^\[runtime:(stdout|stderr)\] ([\s\S]*)$/.exec(args[0]);
      if (m) print(m[2], m[1] === 'stderr' ? 'err' : 'out');
      else if (typeof args[0] === 'string' && args[0].startsWith('[sandburg demo]')) print(args[0], /not recorded/.test(args[0]) ? 'err' : 'dim');
      original(...args);
    };
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sandburg-demo') console.warn(`[sandburg demo] ${e.data.message}`);
  });
  timer = setInterval(() => ($('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`), 100);
  $('status').textContent = 'Running';

  try {
    await phase('load', async () => {
      await import(new URL('host.js', site).href);
      return { ok: true, value: await fetch('demo.json').then((r) => r.json()) };
    }).then(async (demo) => {
      const api = window.__sandburg;
      await phase('mount', () => api.mount(demo.files, demo.packageJson, demo.framework));
      await phase('install', () => api.install(demo.host));
      const { url } = await phase('start', () => api.start());
      await phase('ready', () => api.ready(scope.pathname + 'app' + url));
    });
  } catch (e) {
    return fail(e.message);
  }
  clearInterval(timer);
  const total = ((performance.now() - started) / 1000).toFixed(1);
  $('elapsed').textContent = `${total} s`;
  $('status').textContent = `Running in your browser`;
  $('status').dataset.state = 'done';
  print(`\n✔ ready in ${total} s — the app below is served by the dev server running in this tab.`, 'ok');
}

boot().catch((e) => fail(String(e?.message ?? e)));
