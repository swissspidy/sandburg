/**
 * Tailwind CSS v4 for the esbuild adapter (ADR 0007), in place of the
 * @tailwindcss/vite and @tailwindcss/postcss plugins.
 *
 * Tailwind v4's compiler (`compile` from the `tailwindcss` package) is plain
 * JavaScript. The app's own installed copy is bundled and imported, so the
 * version is the app's. Its class scanner (Oxide) is native code, so
 * candidates come from a simpler scan of the project sources instead. Tailwind
 * ignores tokens that are not classes, so over-collecting is harmless.
 */
import { dirname, type Resolver } from './resolve.ts';

interface Compiler {
  build(candidates: string[]): string;
}
interface TailwindModule {
  compile(
    css: string,
    opts: {
      base: string;
      loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }>;
      loadModule(id: string, base: string, kind: string): Promise<{ path: string; base: string; module: unknown }>;
    },
  ): Promise<Compiler>;
}

export interface TailwindDeps {
  resolver: Resolver;
  read(path: string): Promise<Uint8Array>;
  importPackage(path: string): Promise<Record<string, unknown>>;
}

/** CSS that Tailwind v4 must process. */
export function usesTailwind(css: string): boolean {
  return /@import\s+(url\()?\s*["']tailwindcss(\/[^"']*)?["']|@tailwind\s+utilities|@(theme|plugin|utility|custom-variant)\b/.test(css);
}

const SOURCE = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|mdx?)$/;

/** Class candidates: every token in the project's source files that could be a class. */
export function scanCandidates(files: Record<string, string | Uint8Array>): string[] {
  const out = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string' || !SOURCE.test(path) || path.startsWith('node_modules/')) continue;
    for (const token of content.split(/[\s"'`;{}()<>=,\\]+/)) {
      if (token && token.length < 200 && /[a-z]/i.test(token)) {
        out.add(token);
        // "hover:bg-x." or template leftovers like "${active ? "
        const trimmed = token.replace(/^[^a-z0-9![@-]+|[.:?]+$/gi, '');
        if (trimmed && trimmed !== token) out.add(trimmed);
      }
    }
  }
  return [...out];
}

export class Tailwind {
  private module: Promise<TailwindModule> | null = null;
  private deps: TailwindDeps;

  constructor(deps: TailwindDeps) {
    this.deps = deps;
  }

  async compile(css: string, path: string, candidates: string[]): Promise<string> {
    const { resolver, read } = this.deps;
    const text = async (p: string) => new TextDecoder().decode(await read(p));
    const tw = await this.load(path);
    const compiler = await tw.compile(css, {
      base: dirname(path),
      async loadStylesheet(id, base) {
        const r = await resolver.resolve(id, `${base}/_.css`, { style: true });
        if (!('path' in r)) throw new Error(`cannot load stylesheet "${id}"`);
        return { path: r.path, base: dirname(r.path), content: await text(r.path) };
      },
      loadModule: async (id, base) => {
        const r = await resolver.resolve(id, `${base}/_.js`);
        if (!('path' in r)) throw new Error(`cannot load module "${id}"`);
        const mod = await this.deps.importPackage(r.path);
        return { path: r.path, base: dirname(r.path), module: mod.default ?? mod };
      },
    });
    return compiler.build(candidates);
  }

  private load(from: string): Promise<TailwindModule> {
    this.module ??= (async () => {
      const pkg = await this.deps.resolver.resolve('tailwindcss/package.json', from).catch(() => null);
      if (!pkg || !('path' in pkg)) throw new Error('the "tailwindcss" package is not installed');
      const { version } = JSON.parse(new TextDecoder().decode(await this.deps.read(pkg.path))) as { version: string };
      if (!version.startsWith('4.')) throw new Error(`tailwindcss ${version} is not supported (Tailwind v4 only; v3 needs PostCSS)`);
      const main = await this.deps.resolver.resolve('tailwindcss', from);
      if (!('path' in main)) throw new Error('cannot resolve "tailwindcss"');
      const mod = (await this.deps.importPackage(main.path)) as unknown as TailwindModule;
      if (typeof mod.compile !== 'function') throw new Error(`tailwindcss ${version} has no compile()`);
      return mod;
    })();
    return this.module;
  }
}
