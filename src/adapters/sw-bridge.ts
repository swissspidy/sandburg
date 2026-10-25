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

let registered: Promise<ServiceWorkerRegistration> | null = null;

/**
 * Registers the service worker, once, and resolves when it is active. The host page does as it
 * loads: the workers it starts from then on (the runtime's, see adapters/node/browser.ts) are the
 * service worker's clients, matched by their own URL. The page itself is not until it gives the
 * service worker a port for an app (which claims it then).
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  registered ??= (async () => {
    // A page may name its own service worker (the static demos register theirs under their path).
    const sw = (globalThis as { __sandburgServiceWorker?: { url: string; scope: string } }).__sandburgServiceWorker ?? { url: '/__sw__.js', scope: '/' };
    await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
    return navigator.serviceWorker.ready;
  })();
  registered.catch(() => (registered = null));
  return registered;
}

/** Registers the service worker and keeps handing it a port for app requests; resolves once it controls the page. */
export async function connectServiceWorker(onRequest: (r: BridgedRequest, reply: BridgeReply) => void): Promise<void> {
  handler = onRequest;
  const registration = await registerServiceWorker();
  const controlled = navigator.serviceWorker.controller
    ? null
    : new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
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
  await controlled;
}
