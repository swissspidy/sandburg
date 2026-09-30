/**
 * Egress gateway: the browser's only way out (ADR 0001, decision 2).
 *
 * Every request of a sandbox context is intercepted. Requests to the sandbox's
 * own origin pass through to the host server; requests to allowlisted origins
 * are answered from a content-addressed disk cache, fetched upstream by Node on
 * a miss; everything else is aborted and recorded.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as playwrightRequest, type APIRequestContext, type BrowserContext, type Request } from 'playwright-core';
import type { NetworkEntry } from '../types.ts';

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
    const url = new URL(origin);
    return suffixes.some((s) => url.protocol === `${s.scheme}:` && url.hostname.endsWith(s.suffix) && url.port === '');
  };
}

export class OfflineMissError extends Error {
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
   * Routes all requests of `context`. `localOrigin` is the sandbox origin;
   * `allow` lists upstream origins (e.g. "https://esm.sh").
   */
  async attach(context: BrowserContext, localOrigin: string, allow: string[], stats: EgressStats = newEgressStats()): Promise<EgressStats> {
    const allowed = originMatcher(allow);
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      stats.requests++;
      if (url.origin === localOrigin) return route.continue();
      if (!allowed(url.origin)) {
        stats.blocked.push({ url: req.url(), method: req.method(), reason: 'origin not allowlisted' });
        return route.abort('blockedbyclient');
      }
      if (req.method() !== 'GET' && req.method() !== 'HEAD') {
        stats.blocked.push({ url: req.url(), method: req.method(), reason: 'only GET/HEAD reach allowlisted origins' });
        return route.abort('blockedbyclient');
      }
      try {
        const { response, hit } = await this.fetchCached(req, allowed);
        if (hit) stats.cacheHits++;
        else stats.cacheMisses++;
        return await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch (err) {
        stats.failed.push({ url: req.url(), method: req.method(), reason: err instanceof Error ? err.message : String(err) });
        return route.abort(err instanceof OfflineMissError ? 'internetdisconnected' : 'failed').catch(() => {});
      }
    });
    // HTTP routing does not see WebSockets; without this they would only hit the dead proxy, unrecorded.
    // Sockets to the sandbox origin (dev-server HMR) are not routed: the browser reaches the
    // origin directly, whereas connectToServer() would connect from Node, which cannot resolve
    // *.sandburg.localhost.
    const localHost = new URL(localOrigin).host;
    await context.routeWebSocket((url) => url.host !== localHost, (ws) => {
      stats.requests++;
      stats.blocked.push({ url: ws.url(), method: 'WEBSOCKET', reason: 'WebSockets may only reach the sandbox origin' });
      ws.close({ code: 1008, reason: 'blocked by sandburg' }).catch(() => {});
    });
    return stats;
  }

  async close(): Promise<void> {
    if (this.upstream) await (await this.upstream).dispose();
  }

  private async fetchCached(req: Request, allowed: OriginMatcher): Promise<{ response: CachedResponse; hit: boolean }> {
    const headers = await req.allHeaders();
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED) if (headers[name]) forwarded[name] = headers[name];
    const key = createHash('sha256')
      .update(`${req.method()} ${req.url()}\n${forwarded['user-agent'] ?? ''}`)
      .digest('hex');
    const path = join(this.options.cacheDir, key.slice(0, 2), key);

    const cached = await readCache(path);
    if (cached && cacheable(cached.status)) return { response: cached, hit: true };
    if (this.options.offline) throw new OfflineMissError(req.url());

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchUpstream(req.method(), req.url(), forwarded, path, allowed);
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return { response: await pending, hit: false };
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
    return { status: meta.status, headers: meta.headers, body };
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
