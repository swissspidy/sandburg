/**
 * Browser half of the service-worker bridge (src/adapters/node/sw.js): the
 * sandbox origin's service worker forwards app requests to the host page over
 * a MessagePort, and the adapter answers them (the node runtime from its
 * virtual HTTP servers, the esbuild adapter from its build output).
 */

export interface BridgedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** The current run's handler: a page may run several projects, one after another. */
let handler: ((r: BridgedRequest, port: MessagePort) => void) | null = null;
let listening = false;

/** Registers the service worker and keeps handing it a port for app requests. */
export async function connectServiceWorker(onRequest: (r: BridgedRequest, port: MessagePort) => void): Promise<void> {
  handler = onRequest;
  // A page may name its own service worker (the static demos register theirs under their path).
  const sw = (globalThis as { __sandburgServiceWorker?: { url: string; scope: string } }).__sandburgServiceWorker ?? { url: '/__sw__.js', scope: '/' };
  const registration = await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  }
  const give = () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => handler?.(e.data as BridgedRequest, e.ports[0]);
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
