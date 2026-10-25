/**
 * esbuild's `transform` on the host's native esbuild (ADR NNNN). A program's esbuild is the
 * WebAssembly build, run in the runtime's thread (the esbuild shim in adapters/node/install-rules.ts):
 * Vite 5-7 transform every TypeScript and JSX module with it, ~20-100 ms each in a warm run, one at a
 * time, where the host's native esbuild takes 1-2 ms. A transform is a pure function of its input and
 * options (no plugins, no file system), so the host can answer it without running anything of the
 * app: this module decides which calls it may answer, and asks it.
 *
 * A call goes to the host only when the app's esbuild is a version whose transforms the host's
 * was checked to give exactly (NATIVE_VERSIONS), and every option is one of TRANSFORM_OPTIONS
 * with a plain JSON value. Anything else, and any answer but a result (the host refused it, the code
 * has errors, the host was busy), is transformed by the app's own esbuild, as before: its errors and
 * log output are that version's own.
 */
/** Where the runtime asks (adapters/node/native-transform.ts answers). */
export const NATIVE_TRANSFORM_PATH = '/esbuild-transform';
/** The global the esbuild shim reads the runtime's hook from (a registered symbol: no app name collides with it). */
export const NATIVE_TRANSFORM = Symbol.for('sandburg.esbuildTransform');
/**
 * The esbuild versions whose transforms the host's esbuild (CHECKED_AGAINST) gives exactly: every
 * published 0.25-0.28 release, checked with scripts/esbuild-equivalence.ts (the same code, source
 * maps, warnings and errors on 1,875 transforms of every TypeScript and JSX module of the corpus and
 * fixtures). With another host esbuild, only its own version is answered until the list is checked again.
 */
const CHECKED_AGAINST = '0.28.2';
const NATIVE_VERSIONS = new Set([
  '0.25.0', '0.25.1', '0.25.2', '0.25.3', '0.25.4', '0.25.5', '0.25.6', '0.25.7', '0.25.8', '0.25.9', '0.25.10', '0.25.11', '0.25.12',
  '0.26.0', '0.27.0', '0.27.1', '0.27.2', '0.27.3', '0.27.4', '0.27.5', '0.27.7', '0.28.0', '0.28.1', '0.28.2',
]);
/** Larger requests (input and options) are transformed in the runtime. */
export const NATIVE_MAX_BYTES = 4 << 20;

/**
 * The transform options the host passes on: those esbuild has had, with the same meaning, since
 * 0.25. Not `mangleProps`/`reserveProps` (regular expressions), `mangleCache` (goes with
 * them), or options newer than 0.25.
 */
const TRANSFORM_OPTIONS = new Set([
  'banner', 'charset', 'color', 'define', 'drop', 'dropLabels', 'footer', 'format', 'globalName', 'ignoreAnnotations',
  'jsx', 'jsxDev', 'jsxFactory', 'jsxFragment', 'jsxImportSource', 'jsxSideEffects', 'keepNames', 'legalComments',
  'lineLimit', 'loader', 'logLevel', 'logLimit', 'logOverride', 'minify', 'minifyIdentifiers', 'minifySyntax',
  'minifyWhitespace', 'platform', 'pure', 'sourceRoot', 'sourcefile', 'sourcemap', 'sourcesContent', 'supported',
  'target', 'treeShaking', 'tsconfigRaw',
]);

/** Whether the host's esbuild (`host`) answers for an app's esbuild `version`: its own, or one checked against it. */
export function nativeVersion(version: unknown, host: string): boolean {
  return typeof version === 'string' && (version === host || (host === CHECKED_AGAINST && NATIVE_VERSIONS.has(version)));
}

/**
 * A JSON value with nothing JSON would change: no functions, regular expressions, typed arrays, or
 * non-finite numbers, and undefined only as an object's property (which JSON leaves out, and esbuild
 * reads as absent: Vite's tsconfigRaw has `jsx: undefined` when its own options set the JSX mode).
 */
function plain(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every((v) => plain(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => v === undefined || plain(v, depth + 1));
}

/**
 * Whether a transform's options are ones the host answers for: a plain object of TRANSFORM_OPTIONS
 * with plain values, and a log level that prints nothing esbuild would print from the host
 * (`verbose` and `debug` print as it works; other levels print warnings, which the runtime checks
 * for in the result). Options left undefined are as absent (esbuild's own reading).
 */
export function nativeOptions(options: unknown): options is Record<string, unknown> {
  if (options === undefined) return true;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return false;
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!TRANSFORM_OPTIONS.has(key) || !plain(value)) return false;
  }
  const level = (options as { logLevel?: unknown }).logLevel;
  return level !== 'verbose' && level !== 'debug';
}

/** The options without the keys left undefined (as JSON would drop them; esbuild reads them as absent). */
const defined = (options: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined));

interface TransformResult {
  code: string;
  map: string;
  warnings: { detail?: unknown }[];
}

interface Transport {
  /** The host's address for the runtime (worker.ts's `base`). */
  base: string;
  /** The host's esbuild version. */
  hostVersion: string;
  fetch: typeof fetch;
  /** A POST over the file channel (host-files.ts): null, or a null answer, means HTTP. */
  post?: (url: string, body: Uint8Array) => Promise<{ status: number; body: Uint8Array } | null> | null;
  /** The requests in progress (the runtime's pendingWork: a child process stays alive for them). */
  pending: { count: number };
}

/**
 * The runtime's hook: the host's answer to an eligible transform, or null for the caller's own
 * esbuild (also when the answer has warnings that the app's log level would print). It asks over the
 * file channel (~1 ms), else over HTTP (15-60 ms: every request of a sandbox goes through Playwright).
 */
export function createNativeTransform(t: Transport): (version: unknown, input: unknown, options: unknown) => Promise<TransformResult | null> | null {
  return (version, input, options) => {
    let body: string;
    try {
      if (typeof input !== 'string' || !nativeVersion(version, t.hostVersion) || !nativeOptions(options)) return null;
      body = JSON.stringify([defined(options), input]);
    } catch {
      // Options no plain object would have (a proxy that throws): the app's own esbuild reads them.
      return null;
    }
    // Characters, a cheap first bound: the host checks the bytes.
    if (body.length > NATIVE_MAX_BYTES) return null;
    const url = `${t.base}${NATIVE_TRANSFORM_PATH}?v=${version as string}`;
    const http = () => t.fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }).then(async (res) => (res.status === 200 ? await res.text() : null));
    t.pending.count++;
    const viaChannel = t.post?.(url, new TextEncoder().encode(body));
    return (viaChannel ? viaChannel.then((r) => (r ? (r.status === 200 ? new TextDecoder().decode(r.body) : null) : http())) : http())
      .then((text) => {
        if (text === null) return null;
        const result = JSON.parse(text) as TransformResult;
        if (typeof result?.code !== 'string' || !Array.isArray(result.warnings)) return null;
        const level = (options as { logLevel?: unknown } | undefined)?.logLevel;
        if (result.warnings.length && level !== undefined && level !== 'silent') return null;
        // JSON leaves out a message's `detail` when it is undefined, as it always is in a transform.
        for (const w of result.warnings) if (!('detail' in w)) w.detail = undefined;
        return result;
      })
      .catch(() => null)
      .finally(() => t.pending.count--);
  };
}
