/**
 * How a runtime gets files from the host and the page: bundles and files downloaded on the side,
 * synchronous requests, files the host sends ahead, the file channel and its digests, and the page's
 * compiler (ADR 0029).
 * The preload bundle and its shared copy stay in worker.ts, which init sets up.
 */
import { NativeMessageChannel, nativePostMessage } from './message-ports.ts';
import { traceTransfer } from '../transfer-trace.ts';
import { prefetched, thread, installKey, base, preloadUrl, sharedFile, preloaded, shared, loadPreload, compileCache, vfs, pageCompiler, pack } from './worker.ts';

let installedRequests = 0;

const PRELOAD_AFTER = 0;

const PRELOAD_AFTER_THREAD = 40;

/** The files of a bundle (a little-endian u32 header length, a JSON header [[mode, path, length], …], the bytes). */
export function readBundle(url: string): [string, Uint8Array, string][] {
  const ahead = prefetchedBody(url);
  if (ahead) return bundleFiles(ahead);
  const res = requestSync(url, true);
  if (res.status !== 200) return [];
  return bundleFiles(res.body as Uint8Array);
}

/**
 * Whether the page is still downloading a bundle and files can be asked for over the file channel
 * meanwhile: the host predicts a never-run install's first bundle, which can take seconds (ADR
 * 0026), and the runtime would wait for all of it; it loads what it needs one file at a time
 * instead (the host's prediction transforms those first), and reads the bundle once it is there.
 */
let waitedForChannel = false;

function stillDownloading(url: string): boolean {
  const sab = prefetched[url];
  if (!sab || Atomics.load(new Int32Array(sab, 0, 1), 0) !== 0 || !channel) return false;
  // The channel opens as the runtime starts: worth one short wait (a host without one may not answer).
  const ready = new Int32Array(channel.ready);
  if (!waitedForChannel) Atomics.wait(ready, 0, 0, 100);
  waitedForChannel = true;
  return Atomics.load(ready, 0) === 1;
}

/** A bundle the page downloaded, in its shared memory (not copied), once it has; null if it failed or was not asked for. */
export function prefetchedBody(url: string): Uint8Array | null {
  const sab = prefetched[url];
  if (!sab) return null;
  delete prefetched[url];
  const state = new Int32Array(sab, 0, 2);
  const t0 = performance.now();
  if (Atomics.wait(state, 0, 0, 60_000) === 'timed-out' || Atomics.load(state, 0) !== 1) return null;
  traceTransfer({ hop: 'runtime waits for prefetch', what: url, bytes: Atomics.load(state, 1), encoding: 'shared', ms: performance.now() - t0 });
  return new Uint8Array(sab, 8, Atomics.load(state, 1));
}

export function bundleFiles(bytes: Uint8Array): [string, Uint8Array, string][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as [string, string, number][];
  const files: [string, Uint8Array, string][] = [];
  let at = 4 + length;
  for (const [mode, rel, size] of header) {
    // A negative size names a file that is not in the bundle (see downloadOnSide).
    if (size < 0) {
      downloadOnSide(mode, rel, -size);
      continue;
    }
    files.push([rel, bytes.subarray(at, at + size), mode]);
    at += size;
  }
  return files;
}

/**
 * Large installed files the preload bundle only names (WebAssembly binaries: swc's is 30 MB), which
 * the program reads later with a synchronous request each (~0.3 s for swc's). The digest helper
 * downloads them into shared memory as soon as the bundle is read, and a read waits for what is left
 * of the download instead of making it. Only a program's runtime does (not its threads).
 */
const onSide = new Map<string, { state: Int32Array; shared: SharedArrayBuffer }>();

function downloadOnSide(mode: string, rel: string, size: number): void {
  if (thread || !digester || !installKey) return;
  try {
    const shared = new SharedArrayBuffer(8 + size);
    onSide.set(`${mode}/${rel}`, { state: new Int32Array(shared, 0, 2), shared });
    nativeWorkerPost.call(digester.worker, { fetch: new URL(`${base}/nm/${installKey}/${mode}/${rel}`, workerHref).href, shared });
  } catch {
    onSide.delete(`${mode}/${rel}`);
  }
}

/** A file downloaded on the side (a copy: decoders do not read shared memory), or null to request it. */
function downloadedOnSide(key: string): Uint8Array | null {
  const side = onSide.get(key);
  if (!side) return null;
  onSide.delete(key);
  // Waited for only if the helper runs (it may not have started yet).
  if (!digester || Atomics.load(digester.state, 1) !== 1) return null;
  if (Atomics.wait(side.state, 0, 0, 60_000) === 'timed-out' || Atomics.load(side.state, 0) !== 1) return null;
  return new Uint8Array(side.shared, 8, Atomics.load(side.state, 1)).slice();
}

export function syncGet(url: string, binary: boolean): { status: number; body: Uint8Array | string } {
  if (preloadUrl && installKey && url.startsWith(`${base}/nm/${installKey}/`)) {
    const key = url.slice(base.length + installKey.length + 5);
    let own = sharedFile(key);
    // A miss in the shared bundle is a miss in the bundle: it is this install's, as loadPreload's would be.
    if (!own && !preloaded && !shared && ++installedRequests > (thread ? PRELOAD_AFTER_THREAD : PRELOAD_AFTER) && !stillDownloading(preloadUrl)) {
      loadPreload();
      // A bundle in shared memory (the page downloaded it) is read there.
      own = sharedFile(key);
    }
    if (own) {
      noteRead(key);
      return { status: 200, body: binary ? own : new TextDecoder().decode(own) };
    }
    const hit = preloaded?.get(key);
    if (hit) {
      noteRead(key);
      return { status: 200, body: binary ? hit.slice() : new TextDecoder().decode(hit) };
    }
    const side = downloadedOnSide(key);
    if (side) return { status: 200, body: binary ? side : new TextDecoder().decode(side) };
    const early = sentAhead(key, url);
    if (early) return { status: 200, body: binary ? early : new TextDecoder().decode(early) };
    const res = key.startsWith('f/') ? readAhead(url, key.slice(2)) : key.startsWith('t/') ? withPushed(url) : null;
    if (res) return { status: res.status, body: binary ? res.body : new TextDecoder().decode(res.body) };
  }
  return requestSync(url, binary);
}

/**
 * The preload bundle's files this runtime read, told to the host in batches over the file channel:
 * a bundle holds every file runs of the install ever loaded (and what was predicted for its first
 * run), and a warm next-app-router run read 16 of its 43 MB; the host's next bundle for the install
 * holds what runs read (see markRead in adapters/node/index.ts).
 */
const reads = new Set<string>();
let unreported: string[] = [];
let reportTimer: ReturnType<typeof setTimeout> | null = null;
/** Files per report: a report is one frame of the file channel (MAX_FRAME, 64 KB). */
const REPORT_BATCH = 100;

function noteRead(key: string): void {
  if (!channel || !installKey || reads.has(key)) return;
  reads.add(key);
  unreported.push(key);
  if (unreported.length >= REPORT_BATCH) reportReads();
  else reportTimer ??= nativeSetTimeout(reportReads, 500);
}

function reportReads(): void {
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = null;
  const keys = unreported;
  unreported = [];
  if (keys.length) channel?.post({ note: `${base}/nm/${installKey}/read?files=${encodeURIComponent(keys.join('\n'))}` });
}

/**
 * Installed files the host sent ahead with another (see readAhead in src/adapters/node/index.ts),
 * by "mode/path", until they are read; at most AHEAD_MAX bytes. `covered` holds, by directory, the
 * ranges of file names (first, last) that answers covered, sorted: a name in one is not asked for
 * ahead again (the host left it out), and an answer stops at the next range.
 */
const ahead = new Map<string, Uint8Array>();

const covered = new Map<string, [string, string][]>();

let aheadBytes = 0;

const AHEAD_MAX = 64 << 20;

/**
 * A raw installed file that is not in the preload bundle, asked for with the files after it in its
 * directory: a dev server's first pre-bundle reads a package's files one after another (esbuild read
 * lucide-react's 1,550 icons and their source maps, ~2 ms a request, 7 s of a cold run). Over the
 * file channel only (the host's answer is then a bundle, status 207); null to ask over HTTP.
 */
function readAhead(url: string, rel: string): { status: number; body: Uint8Array } | null {
  const at = rel.lastIndexOf('/');
  const dir = rel.slice(0, at);
  const name = rel.slice(at + 1);
  const ranges = covered.get(dir) ?? [];
  if (aheadBytes >= AHEAD_MAX || ranges.some(([first, last]) => first <= name && name <= last)) return viaChannel(url);
  const until = ranges.find(([first]) => first > name)?.[0];
  const res = viaChannel(`${url}?ahead=1${until === undefined ? '' : `&until=${encodeURIComponent(until)}`}`);
  if (!res || res.status !== 207) return res;
  const files = bundleFiles(res.body);
  for (const [path, bytes, mode] of files.slice(1)) keepAhead(`${mode}/${path}`, bytes);
  const last = files[files.length - 1][0];
  covered.set(dir, [...ranges, [name, last.slice(last.lastIndexOf('/') + 1)] as [string, string]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return { status: 200, body: files[0][1] };
}

/**
 * A transformed installed file, with the modules it requires that the host has transformed already
 * (an install never run: see pushAhead in src/adapters/node/index.ts). Over the file channel only;
 * null to ask over HTTP.
 */
function withPushed(url: string): { status: number; body: Uint8Array } | null {
  if (aheadBytes >= AHEAD_MAX) return viaChannel(url);
  const res = viaChannel(`${url}?ahead=1`);
  if (!res || res.status !== 207) return res;
  const files = bundleFiles(res.body);
  for (const [path, bytes, mode] of files.slice(1)) keepAhead(`${mode}/${path}`, bytes);
  return { status: 200, body: files[0][1] };
}

function keepAhead(key: string, bytes: Uint8Array): void {
  if (ahead.has(key)) return;
  ahead.set(key, bytes);
  aheadBytes += bytes.length;
}

/**
 * A file the host sent ahead, or null. Its use is told to the host, which records it as loaded (as if
 * it had been asked for), so the install's later runs preload it; files never read are not recorded.
 */
function sentAhead(key: string, url: string): Uint8Array | null {
  const bytes = ahead.get(key);
  if (!bytes) return null;
  ahead.delete(key);
  aheadBytes -= bytes.length;
  channel?.post({ note: `${url}?used=1` });
  return bytes;
}

export let compilesLoaded = false;

export function loadCompiles(into: Map<string, string>, asyncModules: boolean): void {
  compilesLoaded = true;
  if (!compileCache?.bundle) return;
  try {
    const res = requestSync(compileCache.bundle, true);
    if (res.status !== 200) return;
    const bytes = res.body as Uint8Array;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))) as [string, number, string, number, number][];
    let at = 4 + length;
    for (const [kind, async, path, codeLength, outLength] of header) {
      // The same key as hostCompile's; compiled as an async module or not, as this runtime would ask.
      if (!!async === (asyncModules && kind !== 'cjs')) into.set(`${kind}:${path}\0${decoder.decode(bytes.subarray(at, at + codeLength))}`, decoder.decode(bytes.subarray(at + codeLength, at + codeLength + outLength)));
      at += codeLength + outLength;
    }
  } catch {
    // compiled by the host, one by one
  }
}

export function requestSync(url: string, binary: boolean): { status: number; body: Uint8Array | string } {
  const fast = url.startsWith(`${base}/nm/`) ? viaChannel(url) : null;
  if (fast) return { status: fast.status, body: binary ? fast.body : new TextDecoder().decode(fast.body) };
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  if (binary) xhr.responseType = 'arraybuffer';
  const t0 = performance.now();
  xhr.send();
  traceTransfer({ hop: 'host→runtime sync xhr', what: url, bytes: binary ? ((xhr.response as ArrayBuffer | null)?.byteLength ?? 0) : xhr.responseText.length, encoding: binary ? 'binary' : 'text', ms: performance.now() - t0 });
  return { status: xhr.status, body: binary ? new Uint8Array(xhr.response as ArrayBuffer) : xhr.responseText };
}

/**
 * SHA-256 of code, computed on a helper thread while this one waits: WebCrypto's digest is
 * asynchronous only, and natively ~5x faster than in JavaScript (next dev's 8 MB vendor chunk: ~50
 * ms, ~240 ms in a JavaScript loop). The helper starts with the runtime; until it has (or if it ever
 * fails to answer), there is no digest.
 */
const NativeWorker = globalThis.Worker;

const workerHref = globalThis.location?.href;

const nativeWorkerPost = NativeWorker?.prototype.postMessage;

const DIGEST_HELPER = `let socket = null, ids = 0, notes = [];
const asked = new Map();
const settle = (shared, status, body) => {
  const state = new Int32Array(shared, 0, 3);
  if (body) new Uint8Array(shared, 12).set(body);
  Atomics.store(state, 1, body ? body.length : 0);
  Atomics.store(state, 2, status);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
};
function open(url, ready) {
  socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    Atomics.store(ready, 0, 1);
    Atomics.notify(ready, 0);
    for (const note of notes) socket.send('0 ' + note);
    notes = [];
  };
  socket.onmessage = ({ data }) => {
    const head = new DataView(data, 0, 8);
    const shared = asked.get(head.getUint32(0, true));
    if (!shared) return;
    asked.delete(head.getUint32(0, true));
    if (shared instanceof MessagePort) return shared.postMessage({ status: head.getUint32(4, true), body: new Uint8Array(data, 8) });
    settle(shared, head.getUint32(4, true), new Uint8Array(data, 8));
  };
  socket.onclose = () => {
    notes = [];
    Atomics.store(ready, 0, 2);
    Atomics.notify(ready, 0);
    for (const shared of asked.values()) shared instanceof MessagePort ? shared.postMessage({ status: 0 }) : settle(shared, 0, null);
    asked.clear();
  };
}
const handle = async ({ data }) => {
  if (data.channel) return open(data.channel, new Int32Array(data.ready));
  if (data.port) return void (data.port.onmessage = handle);
  // A note sent before the socket opens waits for it (what a run read first is what its next run needs most).
  if (data.note) {
    if (socket && socket.readyState === 0 && notes.length < 256) notes.push(data.note);
    return void (socket && socket.readyState === 1 && socket.send('0 ' + data.note));
  }
  if (data.get) {
    if (!socket || socket.readyState !== 1) return settle(data.shared, 0, null);
    const id = ++ids;
    asked.set(id, data.shared);
    return socket.send(id + ' ' + data.get);
  }
  // A POST (a binary frame: id, the path's length, the path, the body), answered on the port given.
  if (data.post) {
    if (!socket || socket.readyState !== 1) return data.reply.postMessage({ status: 0 });
    const id = ++ids;
    asked.set(id, data.reply);
    const path = new TextEncoder().encode(data.post);
    const frame = new Uint8Array(8 + path.length + data.body.length);
    new DataView(frame.buffer).setUint32(0, id, true);
    new DataView(frame.buffer).setUint32(4, path.length, true);
    frame.set(path, 8);
    frame.set(data.body, 8 + path.length);
    return socket.send(frame);
  }
  const state = new Int32Array(data.shared, 0, 2);
  if (data.hello) return Atomics.store(state, 1, 1);
  if (data.fetch) {
    try {
      const res = await fetch(data.fetch);
      const body = new Uint8Array(await res.arrayBuffer());
      if (!res.ok || body.length + 8 > data.shared.byteLength) throw new Error(String(res.status));
      new Uint8Array(data.shared, 8).set(body);
      Atomics.store(state, 1, body.length);
      Atomics.store(state, 0, 1);
    } catch {
      Atomics.store(state, 0, 2);
    }
    return Atomics.notify(state, 0);
  }
  try {
    new Uint8Array(data.shared, 8, 32).set(new Uint8Array(await crypto.subtle.digest('SHA-256', data.bytes)));
    Atomics.store(state, 0, 1);
  } catch {
    Atomics.store(state, 0, 2);
  }
  Atomics.notify(state, 0);
};
onmessage = handle;`;

/** The helper and its shared memory: the answer's state (0 waiting, 1 written, 2 failed), 1 once it runs, the digest. */
let digester: { worker: Worker; shared: SharedArrayBuffer; state: Int32Array } | null = null;

export function startDigester(): void {
  try {
    const worker = new NativeWorker(URL.createObjectURL(new Blob([DIGEST_HELPER], { type: 'text/javascript' })));
    const shared = new SharedArrayBuffer(40);
    digester = { worker, shared, state: new Int32Array(shared, 0, 2) };
    nativeWorkerPost.call(worker, { hello: true, shared });
    openChannel(worker);
  } catch {
    digester = null;
  }
}

/**
 * Installed files over a WebSocket to the host (src/orchestrator/host-socket.ts), which the helper
 * holds: a synchronous XMLHttpRequest costs ~5-7 ms, mostly Playwright's interception of every
 * request (a round trip to Playwright each); a WebSocket message is not intercepted, ~0.5 ms. The
 * runtime waits on its mailbox (state, body length, status, then the body) while the helper asks.
 * Until the socket is open, or if it closes, or for a body over 1 MB (status 0), requests are HTTP.
 * Threads and child processes ask their parent's helper, through a port of their own (shareChannel).
 */
let channel: { post(message: unknown, transfer?: Transferable[]): void; ready: SharedArrayBuffer; mailbox: SharedArrayBuffer | null } | null = null;

const CHANNEL_MAILBOX = 12 + (1 << 20);

function openChannel(worker: Worker): void {
  if (channel || !globalThis.location || typeof WebSocket === 'undefined') return;
  const ready = new SharedArrayBuffer(4);
  channel = { post: (m, t = []) => nativeWorkerPost.call(worker, m, { transfer: t }), ready, mailbox: null };
  const url = new URL(`${base}/files`, workerHref);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  nativeWorkerPost.call(worker, { channel: url.href, ready });
}

/** A port to this runtime's file channel for a thread or child process it starts (the helper answers it directly). */
export function shareChannel(): { port: MessagePort; ready: SharedArrayBuffer } | null {
  const c = channel;
  if (!c) return null;
  const pair = new NativeMessageChannel();
  c.post({ port: pair.port2 }, [pair.port2]);
  return { port: pair.port1, ready: c.ready };
}

export function useChannel(given: { port: MessagePort; ready: SharedArrayBuffer }): void {
  channel = { post: (m, t = []) => nativePostMessage.call(given.port, m, t), ready: given.ready, mailbox: null };
}

/**
 * A POST over the channel, answered asynchronously: the status and body, or null (no channel, or
 * status 0: a path or body the channel does not take) to use HTTP.
 */
export function postViaChannel(url: string, body: Uint8Array): Promise<{ status: number; body: Uint8Array } | null> | null {
  const c = channel;
  if (!c || Atomics.load(new Int32Array(c.ready), 0) !== 1) return null;
  const pair = new NativeMessageChannel();
  const answer = new Promise<{ status: number; body: Uint8Array } | null>((resolve) => {
    pair.port1.onmessage = ({ data }: MessageEvent<{ status: number; body?: Uint8Array }>) => {
      pair.port1.close();
      resolve(data.status && data.body ? { status: data.status, body: data.body } : null);
    };
  });
  c.post({ post: url, body, reply: pair.port2 }, [pair.port2]);
  return answer;
}

/** A GET over the channel: the status and a copy of the body (decoders do not read shared memory), or null to use HTTP. */
function viaChannel(url: string): { status: number; body: Uint8Array } | null {
  const c = channel;
  if (!c || Atomics.load(new Int32Array(c.ready), 0) !== 1) return null;
  c.mailbox ??= new SharedArrayBuffer(CHANNEL_MAILBOX);
  const state = new Int32Array(c.mailbox, 0, 3);
  Atomics.store(state, 0, 0);
  c.post({ get: url, shared: c.mailbox });
  // A helper that does not answer is not asked again (its late answer would land in the mailbox).
  if (Atomics.wait(state, 0, 0, 120_000) === 'timed-out') {
    channel = null;
    return null;
  }
  const status = Atomics.load(state, 2);
  return status ? { status, body: new Uint8Array(c.mailbox, 12, Atomics.load(state, 1)).slice() } : null;
}

/** The hex SHA-256 of text's UTF-8, or null when the helper is not there to compute it. */
export function digestOf(text: string): string | null {
  const d = digester;
  if (!d || Atomics.load(d.state, 1) !== 1) return null;
  try {
    // The bytes move to the helper (WebCrypto does not read shared memory).
    const bytes = new TextEncoder().encode(text);
    Atomics.store(d.state, 0, 0);
    nativeWorkerPost.call(d.worker, { shared: d.shared, bytes: bytes.buffer }, { transfer: [bytes.buffer] });
    // A helper that does not answer is not asked again (its late answer would land in reused memory).
    if (Atomics.wait(d.state, 0, 0, 5000) === 'timed-out' || Atomics.load(d.state, 0) !== 1) throw new Error('no digest');
  } catch {
    digester = null;
    return null;
  }
  return hexOf(d.shared);
}

function hexOf(shared: SharedArrayBuffer): string {
  let hex = '';
  for (const b of new Uint8Array(shared, 8, 32)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Digests of large files the program writes (next dev's chunks, required soon after), computed by
 * the helper as they are written, for when the file is compiled as CommonJS: the runtime does not
 * wait for them then. A digest is of the file's bytes, which are the code's UTF-8 unless they are
 * not valid UTF-8 (no compile has that digest then) or start with a byte order mark (skipped).
 */
const written = new Map<string, { data: Uint8Array; shared: SharedArrayBuffer }>();

const toDigest = new Set<string>();

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

export function digestWhenWritten(path: string): void {
  if (!digester || path.includes('/node_modules/') || !/\.c?js$/.test(path)) return;
  if (!toDigest.size) nativeSetTimeout(digestWritten);
  toDigest.add(path);
}

function digestWritten(): void {
  const d = digester;
  for (const path of toDigest) {
    let data: Uint8Array;
    try {
      data = vfs.read(path);
    } catch {
      continue;
    }
    if (!d || data.length < ASK_FIRST || (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)) continue;
    const prefix = new TextEncoder().encode(`cjs\0${path}\0`);
    const bytes = new Uint8Array(prefix.length + data.length);
    bytes.set(prefix);
    bytes.set(data, prefix.length);
    const shared = new SharedArrayBuffer(40);
    written.set(path, { data, shared });
    nativeWorkerPost.call(d.worker, { shared, bytes: bytes.buffer }, { transfer: [bytes.buffer] });
  }
  toDigest.clear();
}

/** The digest of a CommonJS file as written, if it has been computed and the file is unchanged. */
export function writtenDigest(path: string): string | null {
  const known = written.get(path);
  if (!known || !digester || Atomics.load(digester.state, 1) !== 1) return null;
  try {
    if (vfs.read(path) !== known.data) return null;
  } catch {
    return null;
  }
  // One the helper is still computing is waited for: asking for another would queue behind it.
  const state = new Int32Array(known.shared, 0, 1);
  if (Atomics.wait(state, 0, 0, 5000) === 'timed-out' || Atomics.load(state, 0) !== 1) return null;
  written.delete(path);
  return hexOf(known.shared);
}

/** Code this long is asked for by digest before it is sent to the host to compile. */
export const ASK_FIRST = 1 << 18;

const MAILBOX_HEADER = 8;

export function compileInPage(request: { op: 'compile'; code: string; path: string; kind: string; asyncModules: boolean } | { op: 'tla'; files: Record<string, string> }): string {
  const compiler = pageCompiler!;
  for (;;) {
    const state = new Int32Array(compiler.mailbox, 0, 2);
    Atomics.store(state, 0, 0);
    nativePostMessage.call(compiler.port, { ...request, mailbox: compiler.mailbox }, []);
    while (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0);
    const status = Atomics.load(state, 0);
    const length = Atomics.load(state, 1);
    // Too big for the mailbox: a bigger one, and ask again (the page kept the answer).
    if (status === 3) {
      compiler.mailbox = new SharedArrayBuffer(MAILBOX_HEADER + length);
      continue;
    }
    const text = new TextDecoder().decode(new Uint8Array(compiler.mailbox, MAILBOX_HEADER, length).slice());
    if (status !== 1) throw Object.assign(new SyntaxError(text), { code: 'ERR_COMPILE' });
    return text;
  }
}

/** A port to the page's compiler for a new runtime (a thread or child process): its parent connects it. */
export function connectPageCompiler(): MessagePort | null {
  if (!pageCompiler) return null;
  const channel = new NativeMessageChannel();
  nativePostMessage.call(pageCompiler.port, { op: 'connect', port: channel.port2 }, [channel.port2]);
  return channel.port1;
}

/** An installed file (path relative to the project), or null. */
export function installedFile(rel: string): Uint8Array | null {
  if (pack) {
    const at = pack.index[rel];
    return at ? pack.bytes.slice(at[0], at[0] + at[1]) : null;
  }
  const res = syncGet(`${base}/nm/${installKey}/f/${rel}`, true);
  return res.status === 200 ? (res.body as Uint8Array) : null;
}
