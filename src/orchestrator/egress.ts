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
  async attach(context: BrowserContext, localOrigin: string, allow: string[]): Promise<EgressStats> {
    const stats: EgressStats = { requests: 0, cacheHits: 0, cacheMisses: 0, failed: [], blocked: [] };
    const allowed = new Set(allow.map((o) => new URL(o).origin));
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      stats.requests++;
      if (url.origin === localOrigin) return route.continue();
      if (!allowed.has(url.origin)) {
        stats.blocked.push({ url: req.url(), method: req.method(), reason: 'origin not allowlisted' });
        return route.abort('blockedbyclient');
      }
      if (req.method() !== 'GET' && req.method() !== 'HEAD') {
        stats.blocked.push({ url: req.url(), method: req.method(), reason: 'only GET/HEAD reach allowlisted origins' });
        return route.abort('blockedbyclient');
      }
      try {
        const { response, hit } = await this.fetchCached(req);
        if (hit) stats.cacheHits++;
        else stats.cacheMisses++;
        return await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch (err) {
        stats.failed.push({ url: req.url(), method: req.method(), reason: err instanceof Error ? err.message : String(err) });
        return route.abort(err instanceof OfflineMissError ? 'internetdisconnected' : 'failed').catch(() => {});
      }
    });
    // HTTP routing does not see WebSockets; without this they would only hit the dead proxy, unrecorded.
    const localHost = new URL(localOrigin).host;
    await context.routeWebSocket(/.*/, (ws) => {
      stats.requests++;
      if (new URL(ws.url()).host === localHost) {
        ws.connectToServer();
        return;
      }
      stats.blocked.push({ url: ws.url(), method: 'WEBSOCKET', reason: 'WebSockets may only reach the sandbox origin' });
      ws.close({ code: 1008, reason: 'blocked by sandburg' }).catch(() => {});
    });
    return stats;
  }

  async close(): Promise<void> {
    if (this.upstream) await (await this.upstream).dispose();
  }

  private async fetchCached(req: Request): Promise<{ response: CachedResponse; hit: boolean }> {
    const headers = await req.allHeaders();
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED) if (headers[name]) forwarded[name] = headers[name];
    const key = createHash('sha256')
      .update(`${req.method()} ${req.url()}\n${forwarded['user-agent'] ?? ''}`)
      .digest('hex');
    const path = join(this.options.cacheDir, key.slice(0, 2), key);

    const cached = await readCache(path);
    if (cached) return { response: cached, hit: true };
    if (this.options.offline) throw new OfflineMissError(req.url());

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchUpstream(req.method(), req.url(), forwarded, path);
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return { response: await pending, hit: false };
  }

  private async fetchUpstream(method: string, url: string, headers: Record<string, string>, path: string): Promise<CachedResponse> {
    const api = await this.upstreamContext();
    // Redirects go back to the browser so ES module base URLs stay correct.
    const res = await api.fetch(url, { method, headers, maxRedirects: 0, timeout: 60_000 });
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
    if (response.status < 500) await writeCache(path, url, response);
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
