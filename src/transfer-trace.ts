/**
 * A dev-only tracer of the large transfers between the host, the page and the runtime (off by
 * default): with SANDBURG_TRACE_TRANSFERS=1, every transfer of at least TRACE_MIN_BYTES is printed on
 * the host's stderr as it happens (hop, size, encoding, time), and a table of them by hop and what
 * when the process exits. The page and its workers report theirs as marked console messages, which
 * the session reads (see traceConsole); the host page sets `__sandburgTraceTransfers` for them.
 */
const TRACE_MIN_BYTES = 64 << 10;
/** How the page and the runtime mark a transfer in a console message. */
const TRACE_MARK = 'sandburg:transfer ';

export interface Transfer {
  /** From where to where, and over what: "host→page http", "runtime→page postMessage", … */
  hop: string;
  /** What moved (a host path with keys and digests elided, a message type). */
  what: string;
  bytes: number;
  /** "binary", "json", "base64", "text", "shared" (shared memory, not copied). */
  encoding: string;
  /** How long it took, or how long the receiver waited for it. */
  ms: number;
}

/** In the page or a worker (whose runtime defines a `process` of its own later), not on the host. */
const inBrowser = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' || typeof (globalThis as { document?: unknown }).document !== 'undefined';

/** Whether this process traces transfers (the host). */
export const tracingTransfers = !inBrowser && !!process.env.SANDBURG_TRACE_TRANSFERS;

const seen: Transfer[] = [];

/** Records a transfer on the host (or, in the browser, reports it to the host as a marked console message when tracing is on). */
export function traceTransfer(t: Transfer): void {
  if (t.bytes < TRACE_MIN_BYTES) return;
  if (inBrowser) {
    if ((globalThis as { __sandburgTraceTransfers?: boolean }).__sandburgTraceTransfers) nativeDebug?.(TRACE_MARK + JSON.stringify(t));
    return;
  }
  if (!tracingTransfers) return;
  if (!seen.length) process.once('exit', printTransfers);
  seen.push({ ...t, what: elide(t.what) });
  process.stderr.write(`[transfer] ${t.hop.padEnd(28)} ${kb(t.bytes).padStart(10)} ${t.encoding.padEnd(7)} ${t.ms.toFixed(1).padStart(8)} ms  ${elide(t.what)}\n`);
}

/** The program's console may be replaced; reports go to the realm's own. */
const nativeDebug = typeof console !== 'undefined' ? console.debug.bind(console) : null;

/** A page's marked console message, recorded on the host: true if it was one (and is not the app's). */
export function traceConsole(text: string): boolean {
  if (!text.startsWith(TRACE_MARK)) return false;
  try {
    const t: unknown = JSON.parse(text.slice(TRACE_MARK.length));
    // The page's console is the app's too: only a well-formed report is kept (the summary at exit formats each).
    if (isTransfer(t)) traceTransfer(t);
  } catch {
    // not one of ours after all
  }
  return true;
}

function isTransfer(value: unknown): value is Transfer {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.hop === 'string' && typeof t.what === 'string' && typeof t.encoding === 'string' && Number.isFinite(t.bytes) && Number.isFinite(t.ms);
}

/** Install keys, cache keys and digests are elided so that transfers of the same kind group together. */
function elide(what: string): string {
  return what.replace(/[0-9a-f]{16,64}/g, '…').replace(/\?.*$/, '');
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

function printTransfers(): void {
  const groups = new Map<string, { n: number; bytes: number; ms: number }>();
  for (const t of seen) {
    const key = `${t.hop}\0${t.encoding}\0${t.what}`;
    const g = groups.get(key) ?? { n: 0, bytes: 0, ms: 0 };
    g.n++;
    g.bytes += t.bytes;
    g.ms += t.ms;
    groups.set(key, g);
  }
  const rows = [...groups].sort((a, b) => b[1].bytes - a[1].bytes);
  process.stderr.write(`\ntransfers of ${kb(TRACE_MIN_BYTES)} or more (${seen.length}):\n${'hop'.padEnd(28)} ${'n'.padStart(4)} ${'total'.padStart(10)} ${'enc'.padEnd(7)} ${'ms'.padStart(8)}  what\n`);
  for (const [key, g] of rows) {
    const [hop, encoding, what] = key.split('\0');
    process.stderr.write(`${hop.padEnd(28)} ${String(g.n).padStart(4)} ${kb(g.bytes).padStart(10)} ${encoding.padEnd(7)} ${g.ms.toFixed(0).padStart(8)}  ${what}\n`);
  }
}
