/**
 * `sandburg serve <project>`: a project in your own browser, without Playwright (ADR 0075). A small
 * HTTP server serves a page, the package's prebuilt browser runtime (dist/browser-runtime, ADR 0074)
 * and the project's files; the page installs the project's packages from the npm registry, starts
 * its dev server in the browser runtime and shows the app. Nothing of a Sandburg run's sandbox
 * applies: the app's requests are the browser's, with no egress allowlist, no checks run and no
 * result is written. It is a preview, for a machine where Playwright cannot run (a remote dev box
 * reached over an SSH tunnel) or for a person who wants to click through an app.
 *
 * It listens on 127.0.0.1 unless told otherwise (--host), and answers only requests for the host
 * name it serves on (a page elsewhere cannot read the project through DNS rebinding).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProject } from './project.ts';
import { SnapshotStore } from './store.ts';
import type { Project } from './types.ts';

/** The package's prebuilt browser runtime: <package>/dist/browser-runtime, from src/ (a checkout, after `npm run build`) and from dist/. */
export const DEFAULT_RUNTIME_DIR = fileURLToPath(new URL('../dist/browser-runtime/', import.meta.url));

/** Where the page's own files are (the service worker leaves them to the network: EmbedOptions.pass). */
const OWN = '/sandburg-serve/';
const PROJECT_JSON = `${OWN}project.json`;

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.ts': 'text/plain; charset=utf-8' };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ServeOptions {
  project: Project;
  /** The address to listen on (default 127.0.0.1). */
  host?: string;
  /** The port (default 8787; 0 picks a free one). */
  port?: number;
  /** The browser runtime's directory (default: the package's dist/browser-runtime). */
  runtimeDir?: string;
}

export interface Served {
  /** The page's address, for your browser. */
  url: string;
  close(): Promise<void>;
}

/** Serves a project's preview until close() (see the module's comment). */
export async function serve(options: ServeOptions): Promise<Served> {
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  await readFile(join(runtimeDir, 'index.js')).catch(() => {
    throw new Error(`The browser runtime is not built at ${runtimeDir}. From a checkout, run npm run build first.`);
  });
  const project = JSON.stringify(options.project);
  const listenHost = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => void answer(req, res).catch(() => !res.headersSent && res.writeHead(500).end()));
  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only for the names this server is reached by: a page on another site that resolves its own name to
    // this address (DNS rebinding) gets nothing, the project's source least of all.
    const name = hostName(req.headers.host);
    if (!name || !(LOOPBACK.has(name) || name === listenHost || !LOOPBACK.has(listenHost))) return void res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/' || path === '/index.html') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(PAGE);
    if (path === PROJECT_JSON) return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }).end(project);
    if (path.startsWith('/sandburg/')) {
      const file = normalize(join(runtimeDir, decodeURIComponent(path.slice('/sandburg/'.length))));
      if (!file.startsWith(runtimeDir + sep)) return void res.writeHead(404).end();
      const body = await readFile(file).catch(() => null);
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // The page is at /, above the runtime's directory: the service worker's scope may reach it only so.
        ...(path === '/sandburg/sw.js' && { 'service-worker-allowed': '/', 'cache-control': 'no-cache' }),
      });
      return void res.end(body);
    }
    // Everything else is the app's, answered by the service worker once the page has registered it.
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found (the app is served by the page’s service worker)');
  }
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 8787, listenHost, done);
  });
  const { port } = server.address() as AddressInfo;
  const shown = LOOPBACK.has(listenHost) || listenHost === '0.0.0.0' || listenHost === '::' ? 'localhost' : listenHost.includes(':') ? `[${listenHost}]` : listenHost;
  return {
    url: `http://${shown}:${port}/`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** The host name of a Host header, without its port (and an IPv6 literal without its brackets kept as [::1]). */
function hostName(host: string | undefined): string | null {
  if (!host) return null;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return m ? m[1] : null;
}

const USAGE = `Usage: sandburg serve <project> [--host <address>] [--port <n>]

Serves <project> (a directory, a .zip, a JSON file tree, or snapshot:<id>) for your own browser: the page
installs its packages from the npm registry and runs its dev server in the browser, as the demo site's
generator does. No checks run and no result is written. The app's requests are your browser's: no egress
allowlist applies, unlike sandburg run (docs/guide/cli.md#serve).

Options:
  --host <address>   Address to listen on (default 127.0.0.1). Another one exposes the project's source
                     and the app to whoever reaches it; browsers need HTTPS or localhost for the
                     runtime (forward the port over SSH rather than exposing it)
  --port <n>         Port (default 8787; 0 picks a free one)
  --store <dir>      Snapshot store directory, for snapshot:<id> (default: .sandburg/store)
  -h, --help         Show this help`;

/** The `serve` command: its exit code (0 once stopped by a signal, 2 when the project did not load, 64 a usage error). */
export async function serveMain(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { host: { type: 'string' }, port: { type: 'string' }, store: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 64;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (positionals.length !== 1 || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(USAGE);
    return 64;
  }
  let project: Project;
  try {
    project = await loadProject(positionals[0], new SnapshotStore(values.store ?? '.sandburg/store'));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  const host = values.host ?? '127.0.0.1';
  let served: Served;
  try {
    served = await serve({ project, host, port });
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  console.log(`Serving ${project.name} (${project.framework}) at ${served.url}`);
  console.log("The app runs in your browser: its packages install from the npm registry, and its requests are your browser's, with no egress allowlist (unlike sandburg run). No checks run.");
  if (!LOOPBACK.has(host)) {
    const at = new URL(served.url).port;
    console.warn(`warning: listening on ${host}, not on 127.0.0.1: whoever reaches it gets the project's source and runs its app. Browsers need HTTPS or localhost for the runtime; forwarding the port over SSH instead (ssh -L ${at}:localhost:${at} <this machine>) keeps it on localhost.`);
  }
  console.log('Press Ctrl-C to stop.');
  await new Promise<void>((done) => {
    const stop = () => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await served.close();
  return 0;
}

/**
 * The page: it makes itself cross-origin isolated (the runtime's service worker), loads the project's
 * files, and runs them as a Sandburg run does (mount, install in the page, start, ready).
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandburg serve</title>
<link rel="icon" href="data:,">
<style>
  html, body { margin: 0; height: 100%; font: 13px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; gap: 1em; align-items: center; padding: 4px 10px; border-bottom: 1px solid #8884; }
  #status[data-state="failed"] { color: #c22; }
  #address { opacity: .7; font-family: ui-monospace, monospace; }
  #app { flex: 1; border: 0; width: 100%; }
  #log { margin: 0; padding: 6px 10px; max-height: 30vh; overflow: auto; white-space: pre-wrap; font: 12px ui-monospace, monospace; background: #8881; }
  #log:empty { display: none; }
</style>
</head>
<body>
<header><strong>Sandburg</strong><span id="status">Starting</span><span id="address"></span></header>
<iframe id="app" title="The app"></iframe>
<pre id="log"></pre>
<script type="module">
import { isolate, loadHost, appPath, guardAppFrame, pageInstall } from '/sandburg/index.js';
const options = { base: '/sandburg/', scope: '/', app: '/app', pass: ['${OWN}'] };
const statusEl = document.getElementById('status');
const status = (text, state = '') => { statusEl.textContent = text; statusEl.dataset.state = state; };
const log = (line) => { document.getElementById('log').textContent += line + '\\n'; };
const unwrap = async (call) => { const r = await call; if (!r.ok) throw Object.assign(new Error(r.error.message), { name: r.error.name }); return r.value; };
try {
  if (await isolate(options)) {
    const project = await (await fetch('${PROJECT_JSON}')).json();
    document.title = project.name + ' · Sandburg serve';
    const host = await loadHost(options);
    guardAppFrame(document.getElementById('app'), appPath(options), (a) => { document.getElementById('address').textContent = a; });
    status('Mounting');
    await unwrap(host.mount(project.files, project.packageJson, project.framework));
    status('Installing packages');
    await unwrap(host.install(pageInstall(project)));
    status('Starting');
    const { url } = await unwrap(host.start());
    status('Loading the app');
    await unwrap(host.ready(appPath(options) + url));
    status('Running', 'running');
  }
} catch (e) {
  status('Failed', 'failed');
  log(e.message);
}
</script>
</body>
</html>
`;
