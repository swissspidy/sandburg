/**
 * Svelte for the esbuild adapter (ADR 0011), in place of
 * @sveltejs/vite-plugin-svelte. The app's own `svelte/compiler` compiles
 * components (.svelte) and rune modules (.svelte.js/.svelte.ts) for the
 * client in dev mode, with component CSS injected at runtime. Svelte 5 reads
 * TypeScript in <script lang="ts"> itself; other preprocessors (Sass, PostCSS
 * in <style>) are not run.
 */
import type { Resolver } from './resolve.ts';
import { UnsupportedFeature } from './build-errors.ts';

interface SvelteCompiler {
  VERSION: string;
  compile(source: string, opts: Record<string, unknown>): { js: { code: string }; warnings: { message: string }[] };
  compileModule?(source: string, opts: Record<string, unknown>): { js: { code: string }; warnings: { message: string }[] };
}

export interface SvelteDeps {
  resolver: Resolver;
  importPackage(path: string): Promise<Record<string, unknown>>;
  /** TypeScript → JavaScript (for .svelte.ts modules). */
  stripTypes(code: string, path: string): Promise<string>;
}

export const isSvelteModule = (path: string) => /\.svelte\.[cm]?[jt]s$/.test(path);

export class SvelteCompilerHost {
  private module: Promise<SvelteCompiler> | null = null;
  private deps: SvelteDeps;

  constructor(deps: SvelteDeps) {
    this.deps = deps;
  }

  async compile(source: string, path: string): Promise<{ code: string; warnings: string[] }> {
    const svelte = await this.load(path);
    const style = /<style\b[^>]*\blang=["']?(\w+)/.exec(source)?.[1];
    if (style && style !== 'css') throw new UnsupportedFeature(`${path}: <style lang="${style}"> needs a preprocessor, which the esbuild adapter does not run`);
    try {
      if (isSvelteModule(path)) {
        if (!svelte.compileModule) throw new UnsupportedFeature(`${path}: rune modules need Svelte 5`);
        const js = /\.[cm]?ts$/.test(path) ? await this.deps.stripTypes(source, path) : source;
        const out = svelte.compileModule(js, { filename: path, generate: 'client', dev: true });
        return { code: out.js.code, warnings: out.warnings.map((w) => `${path}: ${w.message}`) };
      }
      const major = Number(svelte.VERSION.split('.')[0]);
      const out = svelte.compile(source, { filename: path, generate: major >= 5 ? 'client' : 'dom', dev: true, css: 'injected' });
      return { code: out.js.code, warnings: out.warnings.map((w) => `${path}: ${w.message}`) };
    } catch (e) {
      if (e instanceof UnsupportedFeature) throw e;
      const err = e as Error & { start?: { line: number; column: number }; position?: [number, number] };
      throw new Error(err.start ? `${path}:${err.start.line}:${err.start.column}: ${err.message}` : `${path}: ${err.message}`);
    }
  }

  private load(from: string): Promise<SvelteCompiler> {
    this.module ??= (async () => {
      const r = await this.deps.resolver.resolve('svelte/compiler', from).catch(() => null);
      if (!r || !('path' in r)) throw new Error('.svelte files need the "svelte" package installed');
      const mod = (await this.deps.importPackage(r.path)) as unknown as SvelteCompiler;
      if (typeof mod.compile !== 'function') throw new Error('svelte/compiler does not export compile()');
      return mod;
    })();
    return this.module;
  }
}
