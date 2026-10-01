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
import { esmSourcefile, patchAsyncFunction, patchFunctionImport, patchInterop } from './interop.ts';

export type CompileKind = 'esm' | 'cjs' | 'ts';

/** eval("<JSON-style string literal>"), as webpack's eval devtools write each module. */
const EVAL_LITERAL = /\beval\(("(?:[^"\\\n]|\\.)*")\)/g;
const PLACEHOLDER = '__sandburg_eval_';
const PLACEHOLDER_CALL = /\beval\("__sandburg_eval_(\d+)"\)/g;
/** Lowered eval literals: the replacement literal, or null when it stays as it is. */
const loweredEvals = new Map<string, string | null>();

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

/** A transform the compiler needs: esbuild's, synchronous on the host, asynchronous in a browser. */
export interface TransformStep {
  code: string;
  options: esbuild.TransformOptions;
  /** A failure is answered with null instead of failing the compilation. */
  optional?: boolean;
}

function runSync(steps: Generator<TransformStep, string, string>): string {
  let step = steps.next();
  while (!step.done) {
    let out: string | null;
    try {
      out = esbuild.transformSync(step.value.code, step.value.options).code;
    } catch (e) {
      if (!step.value.optional) throw e;
      out = null;
    }
    step = steps.next(out as string);
  }
  return step.value;
}

export function compileForRuntime(code: string, path: string, kind: CompileKind, opts: { asyncModules?: boolean } = {}): string {
  const key = createHash('sha256').update(kind).update(opts.asyncModules ? '\0async' : '').update('\0').update(path).update('\0').update(code).digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = runSync(compileSteps(code, path, kind, opts));
  if (cache.size > 5000) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * The same compilation with an asynchronous transform: esbuild's WebAssembly build, which has no
 * synchronous API in a browser (the static demos compile what they did not record, ADR 0015).
 */
export async function compileForRuntimeAsync(
  code: string,
  path: string,
  kind: CompileKind,
  opts: { asyncModules?: boolean },
  transform: (code: string, options: esbuild.TransformOptions) => Promise<string>,
): Promise<string> {
  const steps = compileSteps(code, path, kind, opts);
  let step = steps.next();
  while (!step.done) {
    let out: string | null;
    try {
      out = await transform(step.value.code, step.value.options);
    } catch (e) {
      if (!step.value.optional) throw e;
      out = null;
    }
    step = steps.next(out as string);
  }
  return step.value;
}

/** The compilation, yielding each esbuild transform it needs and taking back its output. */
function* compileSteps(code: string, path: string, kind: CompileKind, opts: { asyncModules?: boolean }): Generator<TransformStep, string, string> {
  // A hashbang (a package's bin script) is only valid as the very first line, and the ESM marker
  // goes before the code: blanked, keeping the line count.
  code = code.replace(/^#!.*/, '');
  let out = patchFunctionImport(patchAsyncFunction(kind === 'cjs' && /\beval\("/.test(code) ? yield* lowerEvalSteps(code) : code));
  let loader: esbuild.Loader = kind === 'ts' ? (path.endsWith('x') ? 'tsx' : 'ts') : 'js';
  const esmSource = kind === 'esm';
  if (kind !== 'cjs') {
    // Types (and JSX) first, keeping the module syntax, so the rewrites below see plain JavaScript.
    const needsJs = (opts.asyncModules && MODULE_SYNTAX.test(out)) || /\bawait\b/.test(out) || /\b(require|module|exports|__dirname|__filename)\b/.test(out);
    if (needsJs) {
      let js = loader === 'js' ? out : yield { code: out, options: { loader, sourcefile: path, target: 'esnext', logLevel: 'silent' } };
      js = renameCommonJsNames(js);
      if ((opts.asyncModules && MODULE_SYNTAX.test(js)) || hasTopLevelAwait(js)) js = toAsyncModule(js);
      out = js;
      loader = 'js';
    }
  }
  // A webpack dev chunk (next dev) is mostly eval("<module>") string literals, lowered above. The final
  // transform only needs the code around them: it runs on a skeleton with each literal replaced by a
  // placeholder, and the literals go back after (a 6 MB vendor chunk: 183 ms -> a few ms).
  const literals: string[] = [];
  const skeleton = kind === 'cjs' && out.includes('eval("') ? out.replace(EVAL_LITERAL, (_m, literal: string) => `eval("${PLACEHOLDER}${literals.push(literal) - 1}")`) : out;
  const transformed = yield {
    code: skeleton,
    options: {
      loader,
      format: kind === 'cjs' ? undefined : 'cjs',
      sourcefile: kind === 'esm' && loader === 'js' ? esmSourcefile(path) : path,
      target: 'es2022',
      supported: LOWER,
      define: kind === 'cjs' ? undefined : { 'import.meta.url': '__sandburg_import_meta_url', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
      logLevel: 'silent',
    },
  };
  out = transformed;
  if (literals.length) {
    let restored = 0;
    out = transformed.replace(PLACEHOLDER_CALL, (_m, i: string) => (restored++, `eval(${literals[Number(i)]})`));
    // Every placeholder must come back as it went in; otherwise transform the whole code.
    if (restored !== literals.length) {
      out = yield {
        code: skeleton.replace(PLACEHOLDER_CALL, (_m, i: string) => `eval(${literals[Number(i)]})`),
        options: { loader, sourcefile: path, target: 'es2022', supported: LOWER, logLevel: 'silent' },
      };
    }
  }
  // Marks code that came from an ES module: the loader resolves its requests with import conditions.
  if (kind !== 'cjs' && (esmSource || MODULE_SYNTAX.test(code))) out = `/*sandburg:esm*/\n${out}`;
  return patchInterop(out);
}

/**
 * Lowers the code in each `eval("<string literal>")`. The literal is a JSON-style
 * double-quoted string (webpack emits JSON.stringify output), so it can be
 * matched, decoded and re-encoded exactly. The call stays a direct eval.
 */
export function lowerEvalStrings(code: string): string {
  return runSync(lowerEvalSteps(code));
}

/** lowerEvalStrings, yielding each transform; a null answer (the transform failed) keeps that eval as it was. */
function* lowerEvalSteps(code: string): Generator<TransformStep, string, string> {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(EVAL_LITERAL)) {
    // A chunk webpack writes again after an edit holds mostly the same modules: each literal is
    // lowered once (next dev's vendor chunk: 273 modules, 13 new after the first edit).
    let replacement = loweredEvals.get(m[1]);
    if (replacement === undefined) {
      replacement = null;
      let inner: string | null = null;
      try {
        inner = JSON.parse(m[1]) as string;
      } catch {
        // not a JSON-style literal: left as it is
      }
      if (inner !== null && /\basync\b|\bawait\b|\bimport\s*\(/.test(inner)) {
        const sourceUrl = /\n\/\/# sourceURL=[^\n]*$/.exec(inner)?.[0] ?? '';
        const lowered: string | null = yield { code: inner, options: { loader: 'js', target: 'es2022', supported: LOWER, logLevel: 'silent' }, optional: true };
        if (lowered !== null) replacement = JSON.stringify(patchInterop(lowered) + sourceUrl);
      }
      if (loweredEvals.size > 20_000) loweredEvals.clear();
      loweredEvals.set(m[1], replacement);
    }
    if (replacement === null) continue;
    out += code.slice(last, m.index) + `eval(${replacement})`;
    last = m.index + m[0].length;
  }
  return last ? out + code.slice(last) : code;
}
