/**
 * Solid for the esbuild adapter (ADR 0011), in place of vite-plugin-solid:
 * JSX in the project's .jsx/.tsx files is compiled by the app's own
 * babel-preset-solid (dom-expressions), with the app's own @babel/core.
 * TypeScript is stripped by esbuild first, keeping the JSX.
 */
import type { Resolver } from './resolve.ts';

interface Babel {
  transformAsync(code: string, opts: Record<string, unknown>): Promise<{ code: string } | null>;
}

export interface SolidDeps {
  resolver: Resolver;
  importPackage(path: string): Promise<Record<string, unknown>>;
  /** TypeScript → JavaScript, JSX preserved. */
  stripTypes(code: string, path: string): Promise<string>;
}

export class SolidCompiler {
  private loaded: Promise<{ babel: Babel; preset: unknown }> | null = null;
  private deps: SolidDeps;

  constructor(deps: SolidDeps) {
    this.deps = deps;
  }

  async compile(source: string, path: string): Promise<string> {
    const { babel, preset } = await this.load(path);
    const js = /\.tsx$/.test(path) ? await this.deps.stripTypes(source, path) : source;
    try {
      const out = await babel.transformAsync(js, {
        filename: path,
        babelrc: false,
        configFile: false,
        browserslistConfigFile: false,
        sourceMaps: 'inline',
        presets: [[preset, { generate: 'dom', hydratable: false, dev: true }]],
      });
      return out?.code ?? js;
    } catch (e) {
      const err = e as Error & { loc?: { line: number; column: number } };
      throw new Error(err.loc ? `${path}:${err.loc.line}:${err.loc.column}: ${err.message.replace(/^[^:]+: /, '')}` : err.message);
    }
  }

  private load(from: string) {
    this.loaded ??= (async () => {
      const resolve = async (name: string) => {
        const r = await this.deps.resolver.resolve(name, from).catch(() => null);
        if (!r || !('path' in r)) throw new Error(`Solid components need "${name}" installed (vite-plugin-solid depends on it)`);
        return (await this.deps.importPackage(r.path)) as Record<string, unknown>;
      };
      const [babelMod, presetMod] = await Promise.all([resolve('@babel/core'), resolve('babel-preset-solid')]);
      const babel = ((babelMod as { transformAsync?: unknown }).transformAsync ? babelMod : babelMod.default) as unknown as Babel;
      return { babel, preset: presetMod.default ?? presetMod };
    })();
    return this.loaded;
  }
}
