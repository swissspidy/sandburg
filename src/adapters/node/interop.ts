/**
 * esbuild's CommonJS interop for code converted from ES modules. In Node mode (importers that are
 * .mjs or "type": "module") `import x from 'pkg'` gets the whole module.exports, as Node does for a
 * CommonJS package. But in the runtime, ES module packages are converted to CommonJS too, and for
 * those the default import must be their `default` export. The runtime records the exports of
 * converted ES modules (globalThis[Symbol.for('sandburg.esm')]); the helper skips Node mode for them.
 */
export function patchInterop(code: string): string {
  return code.replace(
    'var __toESM = (mod, isNodeMode, target) => (',
    'var __toESM = (mod, isNodeMode, target) => (isNodeMode = isNodeMode && !(mod != null && globalThis[Symbol.for("sandburg.esm")]?.has(mod)), ',
  );
}

const ASYNC_FUNCTION_CONSTRUCTOR =
  /\bObject\.getPrototypeOf\(\s*async\s+function\s*\(\s*\)\s*\{\s*\}\s*\)\.constructor\b|\(\s*async\s+function\s*\(\s*\)\s*\{\s*\}\s*\)\.constructor\b|\basync\s+function\s*\(\s*\)\s*\{\s*\}\.constructor\b|\(\s*async\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\.constructor\b/g;

/**
 * The runtime lowers async functions (for AsyncLocalStorage), so `(async function () {}).constructor`
 * would be plain Function, and `new AsyncFunction(…, body)` (Vite's SSR module runner) would reject
 * `await` in the body. Such expressions become the runtime's AsyncFunction, which lowers the body too.
 * Runs on source, before lowering.
 */
export function patchAsyncFunction(source: string): string {
  if (!source.includes('async')) return source;
  return source.replace(ASYNC_FUNCTION_CONSTRUCTOR, '(globalThis[Symbol.for("sandburg.AsyncFunction")] ?? (async function () {}).constructor)');
}

/**
 * The name esbuild is given for an ES module it converts. esbuild applies Node's CommonJS interop
 * (`import x from 'cjs'` is the whole module.exports, even with __esModule) only for .mjs/.mts
 * files, since it does not read package.json "type". The runtime converts only real ES modules
 * (.mjs, or .js in a "type": "module" package), so each gets Node's semantics.
 */
export function esmSourcefile(path: string): string {
  return /\.m[jt]s$/.test(path) ? path : `${path}.mjs`;
}

/**
 * `new Function('s', 'return import(s)')` (a way to keep a native dynamic import in bundled or
 * CommonJS code) reaches the browser's module loader, which knows nothing of node_modules. Inside
 * a Function constructor's string arguments, `import(` goes to the runtime's loader instead
 * (globalThis.__sandburg_import). Runs on source.
 */
export function patchFunctionImport(source: string): string {
  if (!source.includes('import(') || !/\bFunction\s*\(/.test(source)) return source;
  return source.replace(/\bFunction\s*\((?:[^()]|\([^()]*\))*\)/g, (call) =>
    call.replace(/(["'`][^"'`\n]*?)\bimport\(/g, '$1__sandburg_import('),
  );
}
