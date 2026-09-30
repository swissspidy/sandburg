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
 * - Top-level await: such modules become async modules (see tla.ts). With
 *   `asyncModules`, every ES module does, so importers wait for dependencies.
 */
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { hasTopLevelAwait, toAsyncModule } from './tla.ts';
import { renameCommonJsNames } from './esm-names.ts';
import { esmSourcefile, patchAsyncFunction, patchInterop } from './interop.ts';

export type CompileKind = 'esm' | 'cjs' | 'ts';

const LOWER = { 'async-await': false, 'async-generator': false, 'for-await': false, 'dynamic-import': false } as const;
const cache = new Map<string, string>();

/** Whether any of the project's source files uses top-level await (TypeScript is stripped first). */
export function projectHasTopLevelAwait(files: Record<string, string>): boolean {
  return Object.entries(files).some(([path, code]) => {
    if (!/\bawait\b/.test(code)) return false;
    const loader: esbuild.Loader = /\.[cm]?tsx$/.test(path) ? 'tsx' : /\.[cm]?ts$/.test(path) ? 'ts' : /\.jsx$/.test(path) ? 'jsx' : 'js';
    try {
      const js = loader === 'js' ? code : esbuild.transformSync(code, { loader, target: 'esnext', logLevel: 'silent' }).code;
      return hasTopLevelAwait(js);
    } catch {
      return false;
    }
  });
}

const MODULE_SYNTAX = /^\s*(import\s*[\w{*'"]|export\s+[\w{*]|export\s*\{)/m;

export function compileForRuntime(code: string, path: string, kind: CompileKind, opts: { asyncModules?: boolean } = {}): string {
  const key = createHash('sha256').update(kind).update(opts.asyncModules ? '\0async' : '').update('\0').update(path).update('\0').update(code).digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = patchAsyncFunction(kind === 'cjs' && /\beval\("/.test(code) ? lowerEvalStrings(code) : code);
  let loader: esbuild.Loader = kind === 'ts' ? (path.endsWith('x') ? 'tsx' : 'ts') : 'js';
  const esmSource = kind === 'esm';
  if (kind !== 'cjs') {
    // Types (and JSX) first, keeping the module syntax, so the rewrites below see plain JavaScript.
    const needsJs = (opts.asyncModules && MODULE_SYNTAX.test(out)) || /\bawait\b/.test(out) || /\b(require|module|exports|__dirname|__filename)\b/.test(out);
    if (needsJs) {
      let js = loader === 'js' ? out : esbuild.transformSync(out, { loader, sourcefile: path, target: 'esnext', logLevel: 'silent' }).code;
      js = renameCommonJsNames(js);
      if ((opts.asyncModules && MODULE_SYNTAX.test(js)) || hasTopLevelAwait(js)) js = toAsyncModule(js);
      out = js;
      loader = 'js';
    }
  }
  out = esbuild.transformSync(out, {
    loader,
    format: kind === 'cjs' ? undefined : 'cjs',
    sourcefile: kind === 'esm' && loader === 'js' ? esmSourcefile(path) : path,
    target: 'es2022',
    supported: LOWER,
    define: kind === 'cjs' ? undefined : { 'import.meta.url': '__sandburg_import_meta_url', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
    logLevel: 'silent',
  }).code;
  // Marks code that came from an ES module: the loader resolves its requests with import conditions.
  if (kind !== 'cjs' && (esmSource || MODULE_SYNTAX.test(code))) out = `/*sandburg:esm*/\n${out}`;
  out = patchInterop(out);
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
