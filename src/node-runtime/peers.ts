/**
 * Between runtimes (a runtime, its worker threads and child processes): net connections, and
 * requests and WebSockets to servers in another runtime, routed down or up (ADR 0006).
 */
import type { NetMessage, ToParent, ToWorker } from './messages.ts';
import { loopback, servers, type BridgeResponse } from './builtins/http.ts';
import { netEvents, netLinks, netServers, Socket as NetSocket } from './builtins/net.ts';
import { thread, realPostMessage, post, announce, exited } from './worker.ts';
import { ExitError } from './builtins/process.ts';
import { nestedReported } from './process-tree.ts';

type Send = (m: NetMessage, transfer?: Transferable[]) => void;

export const netConns = new Map<number, NetSocket>();

/** Net servers in nested runtimes. */
const nestedNet = new Map<number | string, globalThis.Worker>();

/** Connections whose peer is in a nested runtime, by id: reset if it ends (forgetNested). */
const netPeers = new Map<number, globalThis.Worker>();

let nextNetId = -1 - Math.floor(Math.random() * 2 ** 40);

function bindRemote(socket: NetSocket, id: number, send: Send, nested: globalThis.Worker | null) {
  netConns.set(id, socket);
  if (nested) netPeers.set(id, nested);
  socket.peer = {
    data: (chunk) => {
      const buf = chunk.slice().buffer;
      send({ type: 'net-data', id, data: buf }, [buf]);
    },
    end: () => send({ type: 'net-end', id }),
    close: () => {
      netConns.delete(id);
      netPeers.delete(id);
      send({ type: 'net-close', id });
    },
  };
  socket.once('close', () => {
    netConns.delete(id);
    netPeers.delete(id);
  });
}

netLinks.connect = (key, socket) => {
  const nested = nestedNet.get(key);
  // A server in a nested runtime, else ask the parent (it may have one).
  const send: Send | null = nested ? (m, t) => nested.postMessage(m, t ?? []) : thread ? (m, t) => realPostMessage(m, t ?? []) : null;
  if (!send) return false;
  const id = nextNetId--;
  bindRemote(socket, id, send, nested ?? null);
  send({ type: 'net-connect', id, key });
  return true;
};

netEvents.on('listening', (key: number | string) => {
  if (thread) realPostMessage({ type: 'net-listening', key } satisfies NetMessage);
});

netEvents.on('closed', (key: number | string) => {
  if (thread) realPostMessage({ type: 'net-closed', key } satisfies NetMessage);
});

/** A net message from another runtime; `reply` goes back to it. */
export function netMessage(m: NetMessage, reply: Send, from: globalThis.Worker | null): void {
  switch (m.type) {
    case 'net-connect': {
      const server = netServers.get(m.key);
      if (!server) return reply({ type: 'net-refused', id: m.id, message: `connect ECONNREFUSED ${typeof m.key === 'string' ? m.key : `127.0.0.1:${m.key}`}` });
      const socket = new NetSocket();
      bindRemote(socket, m.id, reply, from);
      socket.connecting = false;
      socket.pending = false;
      server.accept(socket);
      return reply({ type: 'net-connected', id: m.id });
    }
    case 'net-connected':
      return void netConns.get(m.id)?.established();
    case 'net-refused': {
      const socket = netConns.get(m.id);
      netConns.delete(m.id);
      netPeers.delete(m.id);
      return socket?.refuse(m.message);
    }
    case 'net-data':
      return netConns.get(m.id)?.receive(new Uint8Array(m.data));
    case 'net-end':
      return netConns.get(m.id)?.receive(null);
    case 'net-close': {
      const socket = netConns.get(m.id);
      netConns.delete(m.id);
      netPeers.delete(m.id);
      if (socket) {
        socket.peer = null;
        socket.destroy();
      }
      return;
    }
    case 'net-listening':
      if (from) nestedNet.set(m.key, from);
      return;
    case 'net-closed':
      if (from && nestedNet.get(m.key) === from) nestedNet.delete(m.key);
      return;
  }
}

/**
 * Servers in nested runtimes (child processes, worker threads) are reachable like this runtime's own:
 * requests and WebSockets for their ports go down to them, and their replies come back up.
 */
export const nestedPorts = new Map<number | string, globalThis.Worker>();

export const nestedSockets = new Map<number, globalThis.Worker>();

/** Requests in flight to nested runtimes (from the page, a parent or loopback.route), by id: failed if the runtime ends first (forgetNested). */
const inflight = new Map<number, globalThis.Worker>();

/** Requests this runtime's programs made to servers in nested runtimes (http.request to localhost). */
const loopbackRequests = new Map<number, BridgeResponse & { error(message: string, code?: string): void }>();

let nextLoopbackId = -1 - Math.floor(Math.random() * 2 ** 40);

/**
 * A request to a server this runtime does not run: down to the nested runtime that runs it, else up
 * to the parent, which looks among its own servers and its other children (a Vite dev server
 * proxying /api to a backend that the same dev script started).
 */
loopback.route = (target, method, url, headers, body, bridge) => {
  const worker = nestedPorts.get(target);
  if (!worker && !thread) return false;
  const id = nextLoopbackId--;
  loopbackRequests.set(id, bridge);
  const buf = body ? body.slice().buffer : null;
  const msg = { id, port: target, method, url, headers, body: buf };
  if (worker) {
    inflight.set(id, worker);
    worker.postMessage({ type: 'request', ...msg } satisfies ToWorker, buf ? [buf] : []);
    return () => {
      if (!loopbackRequests.delete(id)) return;
      inflight.delete(id);
      worker.postMessage({ type: 'request-cancel', id } satisfies ToWorker);
    };
  }
  realPostMessage({ type: 'lb-request', ...msg }, buf ? [buf] : []);
  return () => {
    if (loopbackRequests.delete(id)) realPostMessage({ type: 'lb-cancel', id } satisfies ToParent);
  };
};

/** A request from the parent that this runtime forwarded to a nested one: its cancel goes on there. */
export function cancelForwarded(id: number): boolean {
  const worker = inflight.get(id);
  if (!worker) return false;
  inflight.delete(id);
  worker.postMessage({ type: 'request-cancel', id } satisfies ToWorker);
  return true;
}

/** A request from the page or the parent for a port a nested runtime serves: down to it. */
export function forwardRequest(msg: Extract<ToWorker, { type: 'request' }>) {
  const worker = nestedPorts.get(msg.port)!;
  inflight.set(msg.id, worker);
  worker.postMessage(msg, msg.body ? [msg.body] : []);
}

/** No server for `port` here or below any more: the parent stops routing it here (see 'listening'). */
export function unannounce(port: number | string) {
  if (thread && !servers.has(port) && !nestedPorts.has(port)) realPostMessage({ type: 'closed', port });
}

/**
 * A nested runtime ended (its process exited or was killed, its thread was terminated): its servers
 * are gone, and what was in flight to them fails as it does when a real process dies, instead of
 * waiting for an answer that never comes.
 */
export function forgetNested(worker: globalThis.Worker) {
  for (const [port, w] of nestedPorts) {
    if (w !== worker) continue;
    nestedPorts.delete(port);
    unannounce(port);
  }
  for (const [key, w] of nestedNet) if (w === worker) nestedNet.delete(key);
  for (const [id, w] of inflight) {
    if (w !== worker) continue;
    inflight.delete(id);
    const own = loopbackRequests.get(id);
    loopbackRequests.delete(id);
    if (own) own.error('socket hang up', 'ECONNRESET');
    else post({ type: 'response-error', id, message: 'socket hang up' });
  }
  // Requests it made to servers here: it went away mid-request, so they are aborted (and answer no one).
  // As a closed connection's events come: later (it may have been killed by the very handler serving it).
  for (const [bridge, entry] of servingLoopback) {
    if (entry.from !== worker) continue;
    servingLoopback.delete(bridge);
    bridge.close();
    queueMicrotask(() => entry.abort());
  }
  for (const [id, w] of nestedSockets) {
    if (w !== worker) continue;
    nestedSockets.delete(id);
    post({ type: 'ws-closed', id, code: 1006, reason: '', wasClean: false });
  }
  for (const [id, w] of netPeers) {
    if (w !== worker) continue;
    const socket = netConns.get(id);
    netConns.delete(id);
    netPeers.delete(id);
    if (!socket) continue;
    socket.peer = null;
    if (socket.connecting) socket.refuse(`connect ECONNREFUSED${socket.remotePort ? ` 127.0.0.1:${socket.remotePort}` : ''}`);
    else socket.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' }));
  }
}

/** The parent's reply to a request sent up by loopback.route. */
export function loopbackReply(m: Extract<ToWorker, { type: `lb-${string}` }>) {
  const bridge = loopbackRequests.get(m.id);
  if (!bridge) return;
  if (m.type === 'lb-start') bridge.start(m.status, m.statusText, m.headers);
  else if (m.type === 'lb-chunk') bridge.chunk(new Uint8Array(m.chunk));
  else {
    loopbackRequests.delete(m.id);
    if (m.type === 'lb-end') bridge.end();
    else bridge.error(m.message, m.code);
  }
}

/**
 * Loopback requests from nested runtimes that this runtime's own servers are answering, with the
 * runtime that asked and what aborts the request (see loopbackServersGone, forgetNested).
 */
const servingLoopback = new Map<{ error(message: string, code?: string): void; close(): void }, { from: globalThis.Worker; abort: () => void }>();

/** This runtime's program exited: its servers' loopback requests fail as with a process that died. */
export function loopbackServersGone(): void {
  for (const bridge of [...servingLoopback.keys()]) bridge.error('socket hang up', 'ECONNRESET');
}

/** For tests (test/runtime): how many loopback requests this runtime's servers are answering. */
(globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.servingLoopback')] = () => servingLoopback.size;

/** What tells the server of each loopback request from a nested runtime that its client went away, by runtime and id. */
const loopbackCancels = new WeakMap<globalThis.Worker, Map<number, () => void>>();

/** A loopback request from a nested runtime: served here, or routed on (see loopback.route). */
function loopbackRequest(m: { id: number; port: number | string; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }, from: globalThis.Worker) {
  const reply = (x: ToWorker, t: Transferable[] = []) => from.postMessage(x, t);
  const id = m.id;
  // Answered once: nothing is sent after its end, or after the program here exited (loopbackServersGone).
  let open = true;
  const close = () => {
    const was = open;
    open = false;
    servingLoopback.delete(bridge);
    cancels.delete(id);
    return was;
  };
  const cancels = loopbackCancels.get(from) ?? new Map<number, () => void>();
  loopbackCancels.set(from, cancels);
  const bridge = {
    start: (status: number, statusText: string, headers: [string, string][]) => open && reply({ type: 'lb-start', id, status, statusText, headers }),
    chunk: (data: Uint8Array) => {
      if (!open) return;
      const chunk = data.slice().buffer;
      reply({ type: 'lb-chunk', id, chunk }, [chunk]);
    },
    end: () => close() && reply({ type: 'lb-end', id }),
    error: (message: string, code?: string) => close() && reply({ type: 'lb-error', id, message, code }),
    close,
  };
  const body = m.body ? new Uint8Array(m.body) : null;
  const server = servers.get(m.port);
  try {
    if (server) {
      // Until it is answered (close()): a response the handler destroys is answered later, its error async.
      const entry = { from, abort: () => {} };
      servingLoopback.set(bridge, entry);
      cancels.set(id, () => close() && entry.abort());
      entry.abort = server.dispatch(m.method, m.url, m.headers, body, bridge);
    } else {
      const cancel = nestedPorts.get(m.port) !== from && loopback.route!(m.port, m.method, m.url, m.headers, body, bridge);
      if (!cancel) bridge.error(`connect ECONNREFUSED ${typeof m.port === 'string' ? m.port : `127.0.0.1:${m.port}`}`, 'ECONNREFUSED');
      else if (open) cancels.set(id, () => close() && cancel());
    }
  } catch (e) {
    // process.exit() in the handler ('request' is emitted as the request is dispatched) ends the process.
    if (e instanceof ExitError) return exited(e.code);
    bridge.error(String((e as Error)?.message ?? e));
  }
}

export function relayFromNested(m: ToParent, from: globalThis.Worker): boolean {
  switch (m.type) {
    case 'net-connect':
    case 'net-connected':
    case 'net-refused':
    case 'net-data':
    case 'net-end':
    case 'net-close':
    case 'net-listening':
    case 'net-closed':
      netMessage(m, (x, t) => from.postMessage(x, t ?? []), from);
      return true;
    case 'response-start':
    case 'response-chunk':
    case 'response-full':
    case 'response-end':
    case 'response-error': {
      if (m.type !== 'response-start' && m.type !== 'response-chunk') inflight.delete(m.id);
      const own = loopbackRequests.get(m.id);
      if (!own) break;
      if (m.type === 'response-start') own.start(m.status, m.statusText, m.headers);
      else if (m.type === 'response-chunk') own.chunk(m.chunk);
      else if (m.type === 'response-full') {
        loopbackRequests.delete(m.id);
        own.start(m.status, m.statusText, m.headers);
        if (m.body.byteLength) own.chunk(new Uint8Array(m.body));
        own.end();
      }
      else {
        loopbackRequests.delete(m.id);
        if (m.type === 'response-end') own.end();
        else own.error(String(m.message), m.code);
      }
      return true;
    }
    default:
      break;
  }
  switch (m.type) {
    case 'process-exit':
      post(m);
      return true;
    case 'starting':
      nestedReported(from, m.count);
      return true;
    case 'lb-request':
      loopbackRequest(m, from);
      return true;
    case 'lb-cancel':
      loopbackCancels.get(from)?.get(m.id)?.();
      return true;
    case 'listening':
      nestedPorts.set(m.port, from);
      announce(m.port, m.ephemeral);
      return true;
    case 'closed':
      if (nestedPorts.get(m.port) === from) {
        nestedPorts.delete(m.port);
        unannounce(m.port);
      }
      return true;
    case 'response-chunk':
      post(m, [m.chunk.buffer as ArrayBuffer]);
      return true;
    case 'response-full':
      post(m, [m.body]);
      return true;
    case 'response-start':
    case 'response-end':
    case 'response-error':
    case 'ws-accept':
    case 'ws-message':
      post(m);
      return true;
    case 'ws-reject':
    case 'ws-closed':
      nestedSockets.delete(m.id);
      post(m);
      return true;
    // The rest are for the nested runtime's own parent object (its Worker or ChildProcess).
    default:
      return false;
  }
}
