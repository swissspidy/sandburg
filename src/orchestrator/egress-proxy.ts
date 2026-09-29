/**
 * Filtering egress proxy: the browser's proxy for requests that Playwright's
 * routing cannot see (a service worker's script fetch and its own requests,
 * for instance). Each browser context authenticates with its own token, which
 * selects that sandbox's allowlist. CONNECT tunnels open only to allowlisted
 * HTTPS origins; everything else is refused and recorded. Tunneled traffic is
 * policed but, being end-to-end TLS, not cached (ADR 0005).
 *
 * One listener per sandbox: the listening port identifies the sandbox.
 * (Proxy credentials would be neater, but Chromium does not send Playwright's
 * proxy credentials with a service worker's script fetch.)
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { EgressStats, OriginMatcher } from './egress.ts';

interface Policy {
  allow: OriginMatcher;
  stats: EgressStats;
}

export class EgressProxy {
  private http: Server;
  private policy: Policy;
  private sockets = new Set<Duplex>();
  port = 0;

  constructor(allow: OriginMatcher, stats: EgressStats) {
    this.policy = { allow, stats };
    this.http = createServer((req, res) => {
      // Plain-HTTP proxying (absolute-URI requests): never allowed.
      const policy = this.policy;
      policy.stats.blocked.push({ url: req.url ?? '', method: req.method ?? 'GET', reason: 'plain HTTP through the egress proxy is not allowed' });
      res.writeHead(403);
      res.end();
    });
    this.http.on('connect', (req, socket, head) => this.onConnect(req, socket, head));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Proxy server URL for the sandbox's browser context. */
  get server(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private onConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.track(socket);
    const policy = this.policy;
    const [host, portText] = (req.url ?? '').split(':');
    const port = Number(portText || 443);
    const origin = port === 443 ? `https://${host}` : `https://${host}:${port}`;
    policy.stats.requests++;
    if (!host || !policy.allow(origin)) {
      policy.stats.blocked.push({ url: origin, method: 'CONNECT', reason: 'origin not allowlisted' });
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    policy.stats.tunneled = (policy.stats.tunneled ?? 0) + 1;
    openUpstream(host, port)
      .then((upstream) => {
        this.track(upstream);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
        const close = () => {
          upstream.destroy();
          socket.destroy();
        };
        upstream.on('error', close);
        socket.on('error', close);
      })
      .catch((err: Error) => {
        policy.stats.failed.push({ url: origin, method: 'CONNECT', reason: err.message });
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
  }
}

/** TCP connection to host:port, through the host's own HTTPS proxy when one is configured. */
function openUpstream(host: string, port: number): Promise<Socket> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxy || noProxy(host)) return tcp(host, port);
  const p = new URL(proxy);
  return tcp(p.hostname, Number(p.port || 80)).then(
    (sock) =>
      new Promise<Socket>((resolve, reject) => {
        const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('latin1');
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          sock.off('data', onData);
          // The data listener switched the socket to flowing mode: pause it so bytes that
          // arrive before the caller pipes it are buffered, not dropped.
          sock.pause();
          if (!/^HTTP\/1\.[01] 200/.test(buf)) {
            sock.destroy();
            reject(new Error(`upstream proxy refused CONNECT ${host}:${port}: ${buf.split('\r\n')[0]}`));
            return;
          }
          const rest = Buffer.from(buf.slice(end + 4), 'latin1');
          if (rest.length) sock.unshift(rest);
          resolve(sock);
        };
        sock.on('data', onData);
        sock.once('error', reject);
      }),
  );
}

function tcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host, () => {
      // The timeout guards connecting only: tunnels may idle between requests (HTTP/2 reuse).
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.setTimeout(30_000, () => sock.destroy(new Error(`connect to ${host}:${port} timed out`)));
    sock.once('error', reject);
  });
}

function noProxy(host: string): boolean {
  const list = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = host.toLowerCase();
  return list.some((entry) => {
    const e = entry.replace(/^\*?\./, '');
    return h === e || h.endsWith(`.${e}`);
  });
}
