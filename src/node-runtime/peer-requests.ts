/**
 * Which nested runtime each request in flight went to (see peers.ts): what comes back about a request
 * (its response, how much of its body its server read, its informational responses) is taken only from
 * the runtime it went to. Runtimes cannot tell each other's request ids apart otherwise.
 */
/** A nested runtime (its Worker). */
type Runtime = { postMessage(message: unknown, transfer?: Transferable[]): void };

/** Requests in flight to nested runtimes (from the page, a parent or loopback.route), by id: failed if the runtime ends first (forgetNested). */
export const inflight = new Map<number, Runtime>();

/** Requests from the parent this runtime forwarded to a nested runtime whose body is still coming, by id. */
export const forwardedBodies = new Map<number, Runtime>();

/** The nested runtime each of this runtime's own loopback requests went to, while its body goes there (see loopback.route). */
export const routedTo = new Map<number, Runtime>();

/** Whether `from` is the runtime request `id` went to (while its response, or its body, is going). */
export function sentBy(id: number, from: Runtime): boolean {
  return inflight.get(id) === from || forwardedBodies.get(id) === from || routedTo.get(id) === from;
}
