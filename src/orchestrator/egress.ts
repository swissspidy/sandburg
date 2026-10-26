/**
 * Egress gateway: the browser's only way out (ADR 0001, decision 2).
 *
 * Every request of a sandbox context is intercepted. Requests to the sandbox's
 * own origin pass through to the host server; requests to allowlisted origins
 * are answered from a content-addressed disk cache, fetched upstream by Node on
 * a miss; everything else is aborted and recorded.
 */
import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as playwrightRequest, type APIRequestContext, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright-core';
import type { NetworkEntry } from '../types.ts';
import { traceTransfer } from '../transfer-trace.ts';

export interface EgressOptions {
  cacheDir: string;
  /** Fail on cache misses instead of fetching upstream. */
  offline: boolean;
}

export interface EgressStats {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  /** Connections the egress proxy tunneled (requests routing cannot see; policed, not cached). */
  tunneled?: number;
  failed: NetworkEntry[];
  blocked: NetworkEntry[];
}

interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** When the entry was written (cache reads only). */
  fetchedAt?: number;
}

interface CacheMeta {
  url: string;
  status: number;
  headers: Record<string, string>;
}

/** Headers that describe the upstream transfer rather than the content. */
const HOP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);
/** Request headers forwarded upstream; they can change what a CDN serves (esm.sh picks its build target by user agent). */
const FORWARDED = ['user-agent', 'accept'];

/** Playwright's abort codes as the Fetch domain names them. */
const ERROR_REASONS = { blockedbyclient: 'BlockedByClient', internetdisconnected: 'InternetDisconnected', failed: 'Failed' } as const;

/** Entries a run's blocked or failed list keeps: a page can make requests without end, each with a URL of megabytes. */
export const MAX_ENTRIES = 200;
/** A recorded URL's length at most. */
export const MAX_URL = 2048;

/** Records a blocked or failed request, within MAX_ENTRIES and MAX_URL. */
export function record(list: NetworkEntry[], entry: NetworkEntry): void {
  if (list.length >= MAX_ENTRIES) return;
  list.push({ ...entry, url: cut(entry.url), reason: cut(entry.reason) });
}

/**
 * The first MAX_URL code units of `s`, as a string of their own: V8 keeps a slice of a long string
 * as a view of it, so 200 cut entries of 1 MB URLs held 200 MB. UTF-16 both ways keeps the code
 * units as they are (lone surrogates too).
 */
function cut(s: string): string {
  return s.length > MAX_URL ? Buffer.from(s.slice(0, MAX_URL), 'utf16le').toString('utf16le') : s;
}

export function newEgressStats(): EgressStats {
  return { requests: 0, cacheHits: 0, cacheMisses: 0, tunneled: 0, failed: [], blocked: [] };
}

/**
 * Only answers that stay true are cached: successes and "does not exist".
 * Never redirects (the browser would follow them outside the gateway) and never
 * transient failures such as 429 rate limits or 5xx, which would otherwise replay forever.
 */
function cacheable(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

/**
 * An npm package's document (https://registry.npmjs.org/<name>) lists the versions published so far,
 * so it changes with every publish: a cached one would hide a version that a newer dependent needs
 * (`No matching version found`). Tarballs and other files do not change.
 */
const PACKUMENT = /^https:\/\/registry\.npmjs\.org\/(?:@[^/]+(?:\/|%2[fF]))?[^/@]+\/?$/;

/** A cached package document older than this is fetched again (or used as is, offline or when the registry cannot be reached). */
export const PACKUMENT_MAX_AGE_MS = 10 * 60_000;

/** Whether a cached answer for `url`, written at `fetchedAt`, may be served without asking upstream. */
export function isFresh(url: string, fetchedAt: number, now = Date.now()): boolean {
  return !PACKUMENT.test(url) || now - fetchedAt < PACKUMENT_MAX_AGE_MS;
}

export type OriginMatcher = (origin: string) => boolean;

/**
 * Allowlist entries are origins ("https://esm.sh") or wildcard origins
 * ("https://*.codesandbox.io", matching any subdomain but not the apex).
 */
export function originMatcher(allow: string[]): OriginMatcher {
  const exact = new Set<string>();
  const suffixes: { scheme: string; suffix: string }[] = [];
  for (const entry of allow) {
    const m = /^(https?):\/\/\*\.([a-z0-9.-]+)$/i.exec(entry);
    if (m) suffixes.push({ scheme: m[1].toLowerCase(), suffix: `.${m[2].toLowerCase()}` });
    else exact.add(new URL(entry).origin);
  }
  return (origin) => {
    if (exact.has(origin)) return true;
    // Opaque origins ("null": data:, blob:, about:) never match.
    if (!/^https?:\/\//.test(origin)) return false;
    // Callers pass what a page asked for: an origin that is not a URL matches nothing.
    const url = URL.parse(origin);
    if (!url) return false;
    return suffixes.some((s) => url.protocol === `${s.scheme}:` && url.hostname.endsWith(s.suffix) && url.port === '');
  };
}

class OfflineMissError extends Error {
  constructor(url: string) {
    super(`offline mode: ${url} is not in the cache`);
    this.name = 'OfflineMissError';
  }
}

export class EgressGateway {
  private options: EgressOptions;
  private upstream: Promise<APIRequestContext> | null = null;
  private inflight = new Map<string, Promise<CachedResponse>>();

  constructor(options: EgressOptions) {
    this.options = options;
  }

  /**
   * Routes the requests of `context`. `localOrigin` is the sandbox origin; `allow` lists upstream
   * origins (e.g. "https://esm.sh").
   *
   * By default only HTTPS requests are intercepted (Chrome DevTools Protocol, Fetch domain, on each
   * page): Playwright's routing pauses every request, the sandbox's own included, for a round trip
   * through this process, and turns off the browser's HTTP cache while any route is set. A run's
   * runtime makes hundreds of requests to its origin (one synchronous request per installed file
   * without a preload bundle). What the interception does not see never gets out either: the context's
   * proxy refuses plain HTTP and, for these contexts, opens no tunnels (a popup's first request comes
   * before its interception is set), and records them (egress-proxy.ts); only the host server's own port
   * on *.sandburg.localhost bypasses the proxy, where the host server refuses requests from another
   * site (host-server.ts). `routeAll` routes every request through Playwright instead: for a
   * context whose proxy is bypassed for every port on *.sandburg.localhost (the reference runtime).
   */
  async attach(context: BrowserContext, localOrigin: string, allow: string[], stats: EgressStats = newEgressStats(), { routeAll = false } = {}): Promise<EgressStats> {
    const allowed = originMatcher(allow);
    if (routeAll) {
      await context.route('**/*', async (route) => {
        const req = route.request();
        stats.requests++;
        try {
          if (new URL(req.url()).origin === localOrigin) return await route.continue();
          const answer = await this.answer(req.method(), req.url(), await req.allHeaders(), allowed, stats);
          if ('abort' in answer) return await route.abort(answer.abort);
          return await route.fulfill({ status: answer.response.status, headers: answer.response.headers, body: answer.response.body });
        } catch {
          // the request is gone, or could not be answered: it fails, and nothing else does
          await route.abort('failed').catch(() => {});
        }
      });
    } else {
      context.on('request', () => stats.requests++);
      const intercept = async (target: Page | Frame) => {
        const session = await context.newCDPSession(target);
        session.on('Fetch.requestPaused', (e) => void this.paused(session, e, localOrigin, allowed, stats));
        await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
      };
      // A frame of another origin in its own process (an iframe of an allowlisted site) has a
      // session of its own; others are their page's (newCDPSession fails for them).
      const watch = (page: Page) => page.on('frameattached', (frame) => void intercept(frame).catch(() => {}));
      context.on('page', (page) => {
        watch(page);
        void intercept(page).catch(() => {});
      });
      for (const page of context.pages()) {
        watch(page);
        await intercept(page);
      }
    }
    // HTTP routing does not see WebSockets; without this they would only hit the dead proxy, unrecorded.
    // Sockets to the sandbox origin (dev-server HMR) are not routed: the browser reaches the
    // origin directly, whereas connectToServer() would connect from Node, which cannot resolve
    // *.sandburg.localhost.
    const localHost = new URL(localOrigin).host;
    await context.routeWebSocket((url) => url.host !== localHost, (ws) => {
      stats.requests++;
      record(stats.blocked, { url: ws.url(), method: 'WEBSOCKET', reason: 'WebSockets may only reach the sandbox origin' });
      ws.close({ code: 1008, reason: 'blocked by sandburg' }).catch(() => {});
    });
    return stats;
  }

  async close(): Promise<void> {
    if (this.upstream) await (await this.upstream).dispose();
  }

  /** What a request that is not the sandbox's gets: an abort (recorded), or the cached or upstream answer. */
  private async answer(
    method: string,
    url: string,
    headers: Record<string, string>,
    allowed: OriginMatcher,
    stats: EgressStats,
  ): Promise<{ abort: 'blockedbyclient' | 'internetdisconnected' | 'failed' } | { response: CachedResponse }> {
    const origin = URL.parse(url)?.origin;
    if (!origin || !allowed(origin)) {
      record(stats.blocked, { url, method, reason: 'origin not allowlisted' });
      return { abort: 'blockedbyclient' };
    }
    if (method !== 'GET' && method !== 'HEAD') {
      record(stats.blocked, { url, method, reason: 'only GET/HEAD reach allowlisted origins' });
      return { abort: 'blockedbyclient' };
    }
    try {
      const { response, hit } = await this.fetchCached(method, url, headers, allowed);
      if (hit) stats.cacheHits++;
      else stats.cacheMisses++;
      return { response };
    } catch (err) {
      record(stats.failed, { url, method, reason: err instanceof Error ? err.message : String(err) });
      return { abort: err instanceof OfflineMissError ? 'internetdisconnected' : 'failed' };
    }
  }

  /** A request paused by the Fetch domain (see attach), answered as Playwright's routing would. */
  private async paused(session: CDPSession, e: { requestId: string; request: { url: string; method: string; headers: Record<string, string> } }, localOrigin: string, allowed: OriginMatcher, stats: EgressStats): Promise<void> {
    const { requestId, request } = e;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    try {
      if (new URL(request.url).origin === localOrigin) return void (await session.send('Fetch.continueRequest', { requestId }));
      // A CORS preflight is answered here, allowing the request, as Playwright's routing does; the
      // request itself is then answered or blocked below.
      if (request.method === 'OPTIONS' && headers['access-control-request-method']) {
        const responseHeaders = [
          { name: 'Access-Control-Allow-Origin', value: headers.origin || '*' },
          { name: 'Access-Control-Allow-Methods', value: headers['access-control-request-method'] || 'GET, POST, OPTIONS, DELETE' },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
        ];
        if (headers['access-control-request-headers']) responseHeaders.push({ name: 'Access-Control-Allow-Headers', value: headers['access-control-request-headers'] });
        return void (await session.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responsePhrase: STATUS_CODES[204], responseHeaders, body: '' }));
      }
      const answer = await this.answer(request.method, request.url, headers, allowed, stats);
      if ('abort' in answer) return void (await session.send('Fetch.failRequest', { requestId, errorReason: ERROR_REASONS[answer.abort] }));
      const { status, headers: responseHeaders, body } = answer.response;
      const fulfilled = Object.entries(responseHeaders).map(([name, value]) => ({ name, value }));
      // As Playwright's fulfill: a cross-origin request's answer allows its origin unless it says
      // otherwise (the registry answers a missing package's 404 without CORS headers).
      if (headers.origin && headers.origin.trim() !== new URL(request.url).origin && !('access-control-allow-origin' in responseHeaders)) {
        fulfilled.push({ name: 'access-control-allow-origin', value: headers.origin }, { name: 'access-control-allow-credentials', value: 'true' }, { name: 'vary', value: 'Origin' });
      }
      const t0 = performance.now();
      await session.send('Fetch.fulfillRequest', { requestId, responseCode: status, responsePhrase: STATUS_CODES[status] ?? '', responseHeaders: fulfilled, body: body.toString('base64') });
      traceTransfer({ hop: 'host→page cdp', what: request.url, bytes: body.length, encoding: 'base64', ms: performance.now() - t0 });
    } catch {
      // the request is gone (its page closed or it was cancelled)
    }
  }

  private async fetchCached(method: string, url: string, headers: Record<string, string>, allowed: OriginMatcher): Promise<{ response: CachedResponse; hit: boolean }> {
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED) if (headers[name]) forwarded[name] = headers[name];
    const key = createHash('sha256')
      .update(`${method} ${url}\n${forwarded['user-agent'] ?? ''}`)
      .digest('hex');
    const path = join(this.options.cacheDir, key.slice(0, 2), key);

    const cached = await readCache(path);
    const usable = cached && cacheable(cached.status) ? cached : null;
    if (usable && (this.options.offline || isFresh(url, usable.fetchedAt ?? 0))) return { response: usable, hit: true };
    if (this.options.offline) throw new OfflineMissError(url);

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchUpstream(method, url, forwarded, path, allowed);
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    if (!usable) return { response: await pending, hit: false };
    // A stale package document: the registry's answer if it has a good one, else the cached one.
    const fresh = await pending.catch(() => null);
    return fresh && cacheable(fresh.status) ? { response: fresh, hit: false } : { response: usable, hit: true };
  }

  private async fetchUpstream(
    method: string,
    url: string,
    headers: Record<string, string>,
    path: string,
    allowed: OriginMatcher,
  ): Promise<CachedResponse> {
    const api = await this.upstreamContext();
    // Redirects are followed here, not in the browser: Playwright does not
    // intercept the follow-up request of a fulfilled redirect, so it would hit
    // the dead proxy. Every hop must stay on an allowlisted origin. The browser
    // sees the final body under the original URL; esm.sh and unpkg use
    // root-relative imports, so module resolution is unaffected.
    let target = url;
    let res = await api.fetch(target, { method, headers, maxRedirects: 0, timeout: 60_000 });
    for (let hop = 0; res.status() >= 300 && res.status() < 400 && res.headers().location; hop++) {
      if (hop === 5) throw new Error(`too many redirects from ${url}`);
      target = new URL(res.headers().location, target).href;
      if (!allowed(new URL(target).origin)) throw new Error(`redirect to non-allowlisted origin: ${target}`);
      res = await api.fetch(target, { method, headers, maxRedirects: 0, timeout: 60_000 });
    }
    const response: CachedResponse = {
      status: res.status(),
      headers: Object.fromEntries(
        res
          .headersArray()
          .filter((h) => !HOP_HEADERS.has(h.name.toLowerCase()))
          .map((h) => [h.name.toLowerCase(), h.value]),
      ),
      body: await res.body(),
    };
    if (cacheable(response.status)) await writeCache(path, url, response);
    return response;
  }

  private upstreamContext(): Promise<APIRequestContext> {
    if (!this.upstream) {
      const server = process.env.HTTPS_PROXY ?? process.env.https_proxy;
      const bypass = process.env.NO_PROXY ?? process.env.no_proxy;
      this.upstream = playwrightRequest.newContext({ proxy: server ? { server, bypass } : undefined });
    }
    return this.upstream;
  }
}

async function readCache(path: string): Promise<CachedResponse | null> {
  try {
    const meta = JSON.parse(await readFile(`${path}.json`, 'utf8')) as CacheMeta;
    const body = await readFile(`${path}.body`);
    return { status: meta.status, headers: meta.headers, body, fetchedAt: (await stat(`${path}.json`)).mtimeMs };
  } catch {
    return null;
  }
}

async function writeCache(path: string, url: string, response: CachedResponse): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const meta: CacheMeta = { url, status: response.status, headers: response.headers };
  // Body first, metadata last: a reader only trusts entries whose metadata exists.
  const tmp = `${path}.${process.pid}.${Date.now()}`;
  await writeFile(`${tmp}.body`, response.body);
  await rename(`${tmp}.body`, `${path}.body`);
  await writeFile(`${tmp}.json`, JSON.stringify(meta));
  await rename(`${tmp}.json`, `${path}.json`);
}
