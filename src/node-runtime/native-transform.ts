/**
 * esbuild's `transform` on the host's native esbuild (ADR NNNN). A program's esbuild is the
 * WebAssembly build, run in the runtime's thread (the esbuild shim in adapters/node/install-rules.ts):
 * Vite 5-7 transform every TypeScript and JSX module with it, ~20-100 ms each in a warm run, one at a
 * time, where the host's native esbuild takes 1-2 ms. A transform is a pure function of its input and
 * options (no plugins, no file system), so the host can answer it without running anything of the
 * app: this module decides which calls it may answer, and asks it.
 *
 * A call goes to the host only when the app's esbuild is a version whose transforms the host's
 * matches (NATIVE_FROM up to the host's own version), and every option is one of TRANSFORM_OPTIONS
 * with a plain JSON value. Anything else, and any answer but a result (the host refused it, the code
 * has errors, the host was busy), is transformed by the app's own esbuild, as before: its errors and
 * log output are that version's own.
 */
/** Where the runtime asks (adapters/node/native-transform.ts answers). */
export const NATIVE_TRANSFORM_PATH = '/esbuild-transform';
/** The global the esbuild shim reads the runtime's hook from (a registered symbol: no app name collides with it). */
export const NATIVE_TRANSFORM = Symbol.for('sandburg.esbuildTransform');
/** The oldest esbuild whose transforms the host answers: 0.25's output matched 0.28's for every corpus and fixture module. */
const NATIVE_FROM: readonly [number, number, number] = [0, 25, 0];
/** Larger requests (input and options) are transformed in the runtime. */
export const NATIVE_MAX_BYTES = 4 << 20;

/**
 * The transform options the host passes on: those esbuild has had, with the same meaning, since
 * NATIVE_FROM. Not `mangleProps`/`reserveProps` (regular expressions), `mangleCache` (goes with
 * them), or options newer than NATIVE_FROM.
 */
const TRANSFORM_OPTIONS = new Set([
  'banner', 'charset', 'color', 'define', 'drop', 'dropLabels', 'footer', 'format', 'globalName', 'ignoreAnnotations',
  'jsx', 'jsxDev', 'jsxFactory', 'jsxFragment', 'jsxImportSource', 'jsxSideEffects', 'keepNames', 'legalComments',
  'lineLimit', 'loader', 'logLevel', 'logLimit', 'logOverride', 'minify', 'minifyIdentifiers', 'minifySyntax',
  'minifyWhitespace', 'platform', 'pure', 'sourceRoot', 'sourcefile', 'sourcemap', 'sourcesContent', 'supported',
  'target', 'treeShaking', 'tsconfigRaw',
]);

const parseVersion = (v: unknown): [number, number, number] | null => {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const compare = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether the host's esbuild (`host`) answers for an app's esbuild `version`: from NATIVE_FROM up to the host's own. */
export function nativeVersion(version: unknown, host: string): boolean {
  const v = parseVersion(version);
  const h = parseVersion(host);
  return !!v && !!h && compare(v, NATIVE_FROM) >= 0 && compare(v, h) <= 0;
}

/** A JSON value with nothing JSON would change: no functions, regular expressions, typed arrays, undefined, or non-finite numbers. */
function plain(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every((v) => plain(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => plain(v, depth + 1));
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

/**
 * The runtime's hook: the host's answer to an eligible transform, or null for the caller's own
 * esbuild (also when the answer has warnings that the app's log level would print). `pending` counts
 * the requests in progress (the runtime's pendingWork: a child process stays alive for them).
 */
export function createNativeTransform(base: string, hostVersion: string, fetchImpl: typeof fetch, pending: { count: number }): (version: unknown, input: unknown, options: unknown) => Promise<TransformResult | null> | null {
  return (version, input, options) => {
    if (typeof input !== 'string' || !nativeVersion(version, hostVersion) || !nativeOptions(options)) return null;
    const body = JSON.stringify([defined(options), input]);
    // Characters, a cheap first bound: the host checks the bytes.
    if (body.length > NATIVE_MAX_BYTES) return null;
    pending.count++;
    return fetchImpl(`${base}${NATIVE_TRANSFORM_PATH}?v=${version as string}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      .then(async (res) => {
        if (res.status !== 200) return null;
        const result = (await res.json()) as TransformResult;
        if (typeof result?.code !== 'string' || !Array.isArray(result.warnings)) return null;
        const level = options?.logLevel;
        if (result.warnings.length && level !== undefined && level !== 'silent') return null;
        // JSON leaves out a message's `detail` when it is undefined, as it always is in a transform.
        for (const w of result.warnings) if (!('detail' in w)) w.detail = undefined;
        return result;
      })
      .catch(() => null)
      .finally(() => pending.count--);
  };
}
