/**
 * Browser half of the service-worker bridge (src/adapters/node/sw.js): the
 * sandbox origin's service worker forwards app requests to the host page over
 * a MessagePort, and the adapter answers them (the node runtime from its
 * virtual HTTP servers, the esbuild adapter from its build output).
 */

export interface BridgedRequest {
  /** The service worker's id for the request: its replies carry it (one port for every request). */
  id?: number;
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** Where the answer to a request goes: start, chunk, end, full or error messages (see sw.js). */
export interface BridgeReply {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

/** The current run's handler: a page may run several projects, one after another. */
let handler: ((r: BridgedRequest, reply: BridgeReply) => void) | null = null;
let listening = false;

/** Registers the service worker and keeps handing it a port for app requests. */
export async function connectServiceWorker(onRequest: (r: BridgedRequest, reply: BridgeReply) => void): Promise<void> {
  handler = onRequest;
  // A page may name its own service worker (the static demos register theirs under their path).
  const sw = globalThis.__sandburgServiceWorker ?? { url: '/__sw__.js', scope: '/' };
  const registration = await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  }
  const give = () => {
    const channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = (e) => {
      const request = e.data as BridgedRequest;
      const id = request.id;
      handler?.(request, { postMessage: (m, transfer = []) => port.postMessage({ ...(m as object), id }, transfer), close() {} });
    };
    (navigator.serviceWorker.controller ?? registration.active)!.postMessage({ type: 'sandburg-port' }, [channel.port2]);
  };
  if (!listening) {
    listening = true;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'sandburg-need-port') give();
    });
  }
  give();
}
