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
import { connect, isIPv6, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { record, type EgressStats, type OriginMatcher } from './egress.ts';

interface Policy {
  allow: OriginMatcher;
  stats: EgressStats;
  /** Refuse every tunnel (see the constructor). */
  noTunnels: boolean;
}

export class EgressProxy {
  private http: Server;
  private policy: Policy;
  private sockets = new Set<Duplex>();
  port = 0;

  /**
   * `noTunnels`: refuse every tunnel, for a context whose HTTPS the gateway intercepts (EgressGateway.attach):
   * what reaches the proxy then is a request the gateway did not see (a popup's or a frame's before its
   * interception is set), and it fails instead of reaching an allowlisted origin unpoliced.
   */
  constructor(allow: OriginMatcher, stats: EgressStats, { noTunnels = false } = {}) {
    this.policy = { allow, stats, noTunnels };
    this.http = createServer((req, res) => {
      // Plain-HTTP proxying (absolute-URI requests): never allowed.
      const policy = this.policy;
      record(policy.stats.blocked, { url: req.url ?? '', method: req.method ?? 'GET', reason: 'plain HTTP through the egress proxy is not allowed' });
      res.writeHead(403);
      res.end();
    });
    // One connection's handling never takes the process down: a fault closes that connection only.
    this.http.on('connect', (req, socket, head) => {
      try {
        this.onConnect(req, socket, head);
      } catch {
        socket.destroy();
      }
    });
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
    policy.stats.requests++;
    const target = parseConnectTarget(req.url ?? '');
    if (!target) {
      record(policy.stats.blocked, { url: req.url ?? '', method: 'CONNECT', reason: 'malformed CONNECT target' });
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const { host, port } = target;
    const authority = host.includes(':') ? `[${host}]` : host;
    const origin = port === 443 ? `https://${authority}` : `https://${authority}:${port}`;
    if (!policy.allow(origin) || policy.noTunnels) {
      const reason = !policy.allow(origin) ? 'origin not allowlisted' : 'HTTPS the gateway did not intercept (a popup or frame before its interception)';
      record(policy.stats.blocked, { url: origin, method: 'CONNECT', reason });
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
        record(policy.stats.failed, { url: origin, method: 'CONNECT', reason: err.message });
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
  }
}

/** The longest CONNECT target taken: a DNS name (253) or a bracketed IPv6 literal, a colon and a port. */
const MAX_TARGET = 261;
/** A DNS name: dot-separated labels of letters, digits, '-' and '_' (1-63 characters each). */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
/** A port: decimal, 1-65535, no sign and no leading zero. */
const PORT = /^[1-9][0-9]{0,4}$/;

/**
 * A CONNECT request's target (authority form, RFC 9110 9.3.6): `host:port`, with an IPv6 literal in
 * brackets (`[::1]:443`). Null for anything else, such as a missing or zero-padded port (`host:0443`
 * is not port 443) or a bracket without its IPv6 literal. The host comes back lowercase, without brackets.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  if (target.length > MAX_TARGET) return null;
  const colon = target.lastIndexOf(':');
  if (colon === -1) return null;
  const hostText = target.slice(0, colon).toLowerCase();
  const portText = target.slice(colon + 1);
  if (!PORT.test(portText)) return null;
  const port = Number(portText);
  if (port > 65535) return null;
  if (hostText.startsWith('[')) {
    if (!hostText.endsWith(']')) return null;
    const ip = hostText.slice(1, -1);
    // Zone IDs (`fe80::1%eth0`) name an interface of this machine: never a target.
    return isIPv6(ip) && !ip.includes('%') ? { host: ip, port } : null;
  }
  return HOSTNAME.test(hostText) ? { host: hostText, port } : null;
}

/** TCP connection to host:port, through the host's own HTTPS proxy when one is configured. */
function openUpstream(host: string, port: number): Promise<Socket> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxy || noProxy(host)) return tcp(host, port);
  let p: URL;
  try {
    p = new URL(proxy);
  } catch {
    return Promise.reject(new Error('HTTPS_PROXY is not a URL'));
  }
  const authority = host.includes(':') ? `[${host}]` : host;
  return tcp(p.hostname, Number(p.port || 80)).then(
    (sock) =>
      new Promise<Socket>((resolve, reject) => {
        const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
        sock.write(`CONNECT ${authority}:${port} HTTP/1.1\r\nHost: ${authority}:${port}\r\n${auth}\r\n`);
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
            reject(new Error(`upstream proxy refused CONNECT ${authority}:${port}: ${buf.split('\r\n')[0]}`));
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
