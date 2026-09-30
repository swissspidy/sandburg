/**
 * Vue single-file components for the esbuild adapter (ADR 0009), in place of
 * @vitejs/plugin-vue. The app's own @vue/compiler-sfc (its self-contained
 * browser build) compiles each .vue file the way the plugin does:
 * <script setup> with the template inlined, or a separate render function;
 * scoped styles with the component's data-v id; TypeScript handed to esbuild.
 */
import type { Loader } from 'esbuild';
import type { Resolver } from './resolve.ts';
import { UnsupportedFeature } from './build-errors.ts';

/* The parts of @vue/compiler-sfc used here. */
interface SfcBlock {
  content: string;
  lang?: string;
  scoped?: boolean;
  module?: string | boolean;
  src?: string;
}
interface SfcDescriptor {
  template: SfcBlock | null;
  script: SfcBlock | null;
  scriptSetup: SfcBlock | null;
  styles: SfcBlock[];
  cssVars: string[];
}
interface SfcError {
  message: string;
  loc?: { start: { line: number; column: number } };
}
interface CompilerSfc {
  parse(source: string, opts: { filename: string; sourceMap?: boolean }): { descriptor: SfcDescriptor; errors: SfcError[] };
  compileScript(d: SfcDescriptor, opts: Record<string, unknown>): { content: string; lang?: string; bindings?: Record<string, unknown> };
  compileTemplate(opts: Record<string, unknown>): { code: string; errors: (SfcError | string)[] };
  compileStyle(opts: Record<string, unknown>): { code: string; errors: Error[] };
}

export interface VueDeps {
  resolver: Resolver;
  /** Project files (for types that <script setup> imports from other files). */
  files: Record<string, string | Uint8Array>;
  importPackage(path: string): Promise<Record<string, unknown>>;
}

export interface CompiledSfc {
  code: string;
  loader: Loader;
  /** Compiled CSS per <style> block, imported by `code` as `<path>?vue&type=style&index=N&lang.css`. */
  styles: string[];
}

/** A short, stable id per component file, as @vitejs/plugin-vue derives it from the path. */
export function componentId(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const STYLE_QUERY = /\?vue&type=style&index=(\d+)&lang\.css$/;

export class VueCompiler {
  private module: Promise<CompilerSfc> | null = null;
  private deps: VueDeps;

  constructor(deps: VueDeps) {
    this.deps = deps;
  }

  async compile(source: string, path: string): Promise<CompiledSfc> {
    const sfc = await this.load(path);
    const { descriptor, errors } = sfc.parse(source, { filename: path, sourceMap: false });
    if (errors.length) throw new Error(errors.map((e) => format(path, e)).join('\n'));
    for (const block of [descriptor.template, descriptor.script, descriptor.scriptSetup, ...descriptor.styles]) {
      if (block?.src) throw new UnsupportedFeature(`${path}: <… src="${block.src}"> blocks are not supported`);
    }

    const id = componentId(path);
    const scopeId = `data-v-${id}`;
    const scoped = descriptor.styles.some((s) => s.scoped);
    const { files } = this.deps;
    // Types imported by defineProps<…>() are read from the project's own files.
    const fs = {
      fileExists: (file: string) => typeof files[file.replace(/^\//, '')] === 'string',
      readFile: (file: string) => {
        const text = files[file.replace(/^\//, '')];
        return typeof text === 'string' ? text : undefined;
      },
    };

    let code: string;
    let lang = 'js';
    let bindings: Record<string, unknown> | undefined;
    if (descriptor.script || descriptor.scriptSetup) {
      const script = sfc.compileScript(descriptor, { id, inlineTemplate: !!descriptor.scriptSetup, genDefaultAs: '_sfc_main', isProd: false, fs });
      code = script.content;
      bindings = script.bindings;
      lang = script.lang ?? descriptor.scriptSetup?.lang ?? descriptor.script?.lang ?? 'js';
    } else {
      code = 'const _sfc_main = {};';
    }
    if (descriptor.template && !descriptor.scriptSetup) {
      const template = sfc.compileTemplate({
        source: descriptor.template.content,
        filename: path,
        id,
        scoped,
        isProd: false,
        compilerOptions: { bindingMetadata: bindings, isTS: lang === 'ts' || lang === 'tsx' },
      });
      if (template.errors.length) throw new Error(template.errors.map((e) => (typeof e === 'string' ? `${path}: ${e}` : format(path, e))).join('\n'));
      code += `\n${template.code.replace(/\nexport (function|const) (render|ssrRender)\b/, '\n$1 _sfc_render')}\n_sfc_main.render = _sfc_render;`;
    }

    const styles: string[] = [];
    descriptor.styles.forEach((style, index) => {
      if (style.lang && style.lang !== 'css') throw new UnsupportedFeature(`${path}: <style lang="${style.lang}"> is not supported (plain CSS only)`);
      if (style.module) throw new UnsupportedFeature(`${path}: <style module> is not supported`);
      const out = sfc.compileStyle({ source: style.content, filename: path, id: scopeId, scoped: !!style.scoped, isProd: false });
      if (out.errors.length) throw new Error(out.errors.map((e) => `${path}: ${e.message}`).join('\n'));
      styles.push(out.code);
      code = `import ${JSON.stringify(`${path}?vue&type=style&index=${index}&lang.css`)};\n${code}`;
    });
    if (scoped) code += `\n_sfc_main.__scopeId = ${JSON.stringify(scopeId)};`;
    code += `\n_sfc_main.__file = ${JSON.stringify(path)};\nexport default _sfc_main;\n`;
    return { code, loader: lang === 'tsx' ? 'tsx' : lang === 'ts' ? 'ts' : lang === 'jsx' ? 'jsx' : 'js', styles };
  }

  private load(from: string): Promise<CompilerSfc> {
    this.module ??= (async () => {
      const r = await this.deps.resolver.resolve('@vue/compiler-sfc', from).catch(() => null);
      const main = r && 'path' in r ? r : await this.deps.resolver.resolve('vue/compiler-sfc', from).catch(() => null);
      if (!main || !('path' in main)) throw new Error('.vue files need the "vue" package (its @vue/compiler-sfc) installed');
      const mod = (await this.deps.importPackage(main.path)) as unknown as CompilerSfc;
      if (typeof mod.parse !== 'function' || typeof mod.compileScript !== 'function') throw new Error('@vue/compiler-sfc does not export parse/compileScript');
      return mod;
    })();
    return this.module;
  }
}

function format(path: string, e: SfcError): string {
  return e.loc ? `${path}:${e.loc.start.line}:${e.loc.start.column}: ${e.message}` : `${path}: ${e.message}`;
}
