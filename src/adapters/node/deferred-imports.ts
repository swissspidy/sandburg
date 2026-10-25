/**
 * Imports a framework evaluates as its dev server starts, for features a project may not use: the
 * module is loaded at its first use instead (ADR NNNN). Astro's config entry point re-exports the svgo
 * optimizer (svgo, csso, css-tree: ~0.13 s of a warm start, for the `svgOptimizer` option); its fonts
 * plugin imports unifont and capsize (for the `fonts` option); its Markdown processor the MDX
 * compiler, whose import instantiates Sätteri's WebAssembly build (for .mdx files).
 *
 * Applied to the CommonJS the host's transform makes of an ES module (transformForRuntime): a
 * listed `var import_x = require("…")` becomes a namespace that requires the module when one of its
 * properties is first read. Only the time the module is evaluated changes: modules listed here
 * have no side effects at evaluation that the importer relies on.
 */
export const DEFERRED_IMPORTS: { file: RegExp; specifiers: string[] }[] = [
  { file: /(^|\/)node_modules\/astro\/dist\/assets\/svg\/svgo\.js$/, specifiers: ['svgo'] },
  { file: /(^|\/)node_modules\/astro\/dist\/assets\/fonts\/vite-plugin-fonts\.js$/, specifiers: ['./infra/unifont-font-resolver.js', './infra/capsize-font-metrics-resolver.js'] },
  { file: /(^|\/)node_modules\/@astrojs\/markdown-satteri\/dist\/processor\.js$/, specifiers: ['./mdx/create-processor.js'] },
];

/**
 * A namespace that loads on first use. Function declarations are hoisted, so this can come last in
 * the module; `get` is what esbuild's CommonJS reads (`(0, import_x.name)(…)`, `new import_x.Name()`).
 */
const DEFER_HELPER = `
function __sandburgDefer(load) { // sandburg: see deferred-imports.ts
  let m;
  const target = () => (m ??= load());
  return new Proxy({}, {
    get: (_, k) => target()[k],
    has: (_, k) => k in target(),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor: (_, k) => { const d = Reflect.getOwnPropertyDescriptor(target(), k); return d && { ...d, configurable: true }; },
  });
}`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `code` (esbuild's CommonJS of the module at `path`) with its listed imports deferred; unchanged when none apply. */
export function deferImports(code: string, path: string): string {
  let deferred = false;
  for (const rule of DEFERRED_IMPORTS) {
    if (!rule.file.test(path)) continue;
    for (const spec of rule.specifiers) {
      const require = new RegExp(`^var (import_\\w+) = ((?:__toESM\\()?require\\(${escape(JSON.stringify(spec))}\\)(?:, 1\\))?);$`, 'm');
      code = code.replace(require, (_, name: string, load: string) => {
        deferred = true;
        return `var ${name} = __sandburgDefer(() => ${load});`;
      });
    }
  }
  return deferred ? code + DEFER_HELPER : code;
}
