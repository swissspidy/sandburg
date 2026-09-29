/**
 * Host-side compilation for the node runtime (ADR 0006). Runs native esbuild on
 * code the browser runtime is about to execute; it never runs the code.
 *
 * - ESM → CommonJS (the runtime's loader is CommonJS, like require()).
 * - TypeScript → JavaScript (Node 24 strips types natively).
 * - async functions/generators are lowered, so AsyncLocalStorage context
 *   survives `await` (see src/node-runtime/async-context.ts).
 * - Code inside webpack's `eval("...")` modules (Next.js dev bundles use the
 *   eval-source-map devtool) is lowered too, in place, keeping direct-eval scope.
 */
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';

export type CompileKind = 'esm' | 'cjs' | 'ts';

const LOWER = { 'async-await': false, 'async-generator': false, 'for-await': false } as const;
const cache = new Map<string, string>();

export function compileForRuntime(code: string, path: string, kind: CompileKind): string {
  const key = createHash('sha256').update(kind).update('\0').update(path).update('\0').update(code).digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = kind === 'cjs' && /\beval\("/.test(code) ? lowerEvalStrings(code) : code;
  out = esbuild.transformSync(out, {
    loader: kind === 'ts' ? (path.endsWith('x') ? 'tsx' : 'ts') : 'js',
    format: kind === 'cjs' ? undefined : 'cjs',
    sourcefile: path,
    target: 'es2022',
    supported: LOWER,
    define: kind === 'cjs' ? undefined : { 'import.meta.url': '__sandburg_import_meta_url', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
    logLevel: 'silent',
  }).code;
  if (cache.size > 5000) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * Lowers the code in each `eval("<string literal>")`. The literal is a JSON-style
 * double-quoted string (webpack emits JSON.stringify output), so it can be
 * matched, decoded and re-encoded exactly. The call stays a direct eval.
 */
export function lowerEvalStrings(code: string): string {
  return code.replace(/\beval\(("(?:[^"\\\n]|\\.)*")\)/g, (whole, literal: string) => {
    let inner: string;
    try {
      inner = JSON.parse(literal);
    } catch {
      return whole;
    }
    if (!/\basync\b|\bawait\b/.test(inner)) return whole;
    const sourceUrl = /\n\/\/# sourceURL=[^\n]*$/.exec(inner)?.[0] ?? '';
    try {
      const lowered = esbuild.transformSync(inner, { loader: 'js', target: 'es2022', supported: LOWER, logLevel: 'silent' }).code;
      return `eval(${JSON.stringify(lowered + sourceUrl)})`;
    } catch {
      return whole;
    }
  });
}
