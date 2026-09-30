/**
 * angular adapter (browser half, ADR 0008): `ng serve` in two steps.
 *
 * 1. Compile: the app's own @angular/compiler-cli runs AOT (with template
 *    type-checking) inside Sandburg's Node.js runtime, in a Web Worker
 *    (ngc-driver.cjs).
 * 2. Bundle: the emitted JavaScript, polyfills and global styles are bundled
 *    with esbuild-wasm in this page (the esbuild adapter's build), and served
 *    through the sandbox's service worker.
 */
import * as esbuild from 'esbuild-wasm';
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import type { FromWorker } from '../../node-runtime/worker.ts';
import { connectServiceWorker } from '../sw-bridge.ts';
import { BuildError, buildApp, type Asset } from '../esbuild/build.ts';
import { createResponder, decodeTree, initEsbuild, installReport, readNodeModule } from '../esbuild/browser.ts';
import { readAngularWorkspace, type AngularBuild } from './workspace.ts';
import type { AngularHostInstall } from './index.ts';

interface NgcResult {
  type: 'ngc';
  ok: boolean;
  errors: string;
  warnings?: string;
  /** Emitted JavaScript by project-relative path ("src/app/app.js"). */
  files: Record<string, string>;
  /** Compiled global Sass by source path. */
  styles: Record<string, string>;
  internal?: boolean;
  ms?: number;
}

const DRIVER = '.sandburg/ngc.cjs';
/** Linker workers used while bundling. */
const LINKERS = 2;
const ENTRY = '.sandburg/angular-entry.js';

export function createAdapter(): RuntimeAdapter {
  let tree: FileTree = {};
  let files: Record<string, string | Uint8Array> = {};
  let workspace: AngularBuild;
  let host: AngularHostInstall;
  let assets = new Map<string, Asset>();
  let html = '';
  const respond = createResponder(() => ({ assets, html, files, statics: workspace.assets, projectFiles: false }));

  /** ngc-driver.cjs in a Node.js runtime worker: the compile step, or a linker that answers link requests. */
  class DriverWorker {
    readonly result: Promise<NgcResult>;
    pending = 0;
    private worker = new Worker('/__sandburg/node-worker.js');
    private links = new Map<number, { resolve(code: string): void; reject(e: Error): void }>();
    private nextId = 1;
    private failure: Error | null = null;

    constructor(ctx: AdapterContext, driver: string, mode: 'compile' | 'link') {
      const sassStyles = workspace.styles.filter((s) => /\.s[ac]ss$/.test(s));
      let settle!: { resolve(r: NgcResult): void; reject(e: Error): void };
      this.result = new Promise<NgcResult>((resolve, reject) => (settle = { resolve, reject }));
      this.result.catch(() => {});
      const fail = (e: Error) => {
        this.failure ??= e;
        settle.reject(e);
        for (const l of this.links.values()) l.reject(e);
        this.links.clear();
      };
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'log') {
          // Linkers are quiet helpers; their output would duplicate the compiler's.
          if (mode === 'compile') for (const line of m.text.replace(/\n$/, '').split('\n')) ctx.log(m.stream, line);
        } else if (m.type === 'ready') this.worker.postMessage({ type: 'run', main: `/app/${DRIVER}` });
        else if (m.type === 'message') {
          const data = m.data as NgcResult | { type: 'linked'; id: number; code?: string; error?: string };
          if (data?.type === 'ngc') settle.resolve(data);
          else if (data?.type === 'linked') {
            const l = this.links.get(data.id);
            this.links.delete(data.id);
            this.pending--;
            if (data.error !== undefined) l?.reject(new Error(`Angular linker: ${data.error}`));
            else l?.resolve(data.code!);
          }
        } else if (m.type === 'fatal') fail(new AdapterError('INTERNAL', `Angular ${mode} worker crashed: ${m.stack ?? m.message}`));
        else if (m.type === 'exit') fail(new AdapterError('INTERNAL', `Angular ${mode} worker exited with code ${m.code}`));
      };
      this.worker.onerror = (e) => fail(new AdapterError('INTERNAL', `runtime worker error: ${e.message}`));
      this.worker.postMessage({
        type: 'init',
        cwd: '/app',
        env: {
          NG_CLI_ANALYTICS: 'false',
          SANDBURG_NGC: JSON.stringify({ mode, tsConfig: workspace.tsConfig, inlineStyleLanguage: workspace.inlineStyleLanguage, includePaths: workspace.includePaths, sassStyles }),
        },
        files: { ...tree, [DRIVER]: driver },
        installKey: host.key,
        nodeModules: host.index,
        base: '/__sandburg',
        ipc: true,
      });
    }

    /** Runs the Angular Linker over a library file (partial declarations → full AOT). */
    link(path: string, code: string): Promise<string> {
      if (this.failure) return Promise.reject(this.failure);
      const id = this.nextId++;
      this.pending++;
      return new Promise<string>((resolve, reject) => {
        this.links.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'message', data: { type: 'link', id, path: `/app${path}`, code } });
      });
    }

    terminate() {
      this.worker.terminate();
    }
  }

  return {
    name: 'angular',

    async mount(t: FileTree) {
      tree = t;
      files = decodeTree(t);
      try {
        workspace = readAngularWorkspace(files);
      } catch (e) {
        throw new AdapterError('APP', `angular.json: ${(e as Error).message}`);
      }
      if (typeof files[workspace.index] !== 'string') throw new AdapterError('APP', `${workspace.index} (the index page in angular.json) is missing`);
    },

    async install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport> {
      host = hostData as AngularHostInstall;
      await initEsbuild();
      return installReport(ctx, host);
    },

    async start(ctx: AdapterContext) {
      const t0 = performance.now();
      const driver = await fetch('/__sandburg/angular/ngc.cjs').then((r) => {
        if (!r.ok) throw new AdapterError('INTERNAL', `runtime asset failed to load: ngc.cjs (HTTP ${r.status})`);
        return r.text();
      });
      const compiler = new DriverWorker(ctx, driver, 'compile');
      // Linkers start now, so Babel and the linker are loaded by the time bundling needs them.
      const linkers = Array.from({ length: LINKERS }, () => new DriverWorker(ctx, driver, 'link'));
      try {
        const result = await compiler.result;
        compiler.terminate();
        if (result.warnings) for (const line of result.warnings.trimEnd().split('\n')) ctx.log('stderr', line);
        if (!result.ok) throw new AdapterError(result.internal ? 'INTERNAL' : 'APP', `Angular compilation failed:\n${result.errors.trim()}`);
        ctx.log('stdout', `compiled ${Object.keys(result.files).length} files in ${Math.round(performance.now() - t0)} ms`);
        await bundle(result, linkers, ctx);
      } finally {
        compiler.terminate();
        for (const l of linkers) l.terminate();
      }
      await connectServiceWorker(respond);
      return { url: '/' };
    },

    async dispose() {},
  };

  async function bundle(result: NgcResult, linkers: DriverWorker[], ctx: AdapterContext) {
    // The emitted JavaScript replaces the TypeScript sources it came from.
    const built: Record<string, string | Uint8Array> = { ...files };
    for (const [out, code] of Object.entries(result.files)) {
      delete built[out.replace(/\.js$/, '.ts')];
      built[out] = code;
    }
    for (const [src, css] of Object.entries(result.styles)) built[`${src}.css`] = css;
    const specifier = (spec: string) => (built[spec] !== undefined || built[`${spec}.ts`] !== undefined || built[`${spec}.js`] !== undefined ? `/${spec}` : spec);
    // Polyfills, global styles, then the app, in the order the Angular CLI loads them.
    built[ENTRY] = [
      ...workspace.polyfills.map((p) => `import ${JSON.stringify(specifier(p))};`),
      ...workspace.styles.map((s) => `import ${JSON.stringify(`/${/\.s[ac]ss$/.test(s) ? `${s}.css` : s}`)};`),
      `import ${JSON.stringify(`/${workspace.main.replace(/\.ts$/, '.js')}`)};`,
    ].join('\n');
    const index = (files[workspace.index] as string).replace(/<\/body>/i, `<script type="module" src="/${ENTRY}"></script>\n</body>`);

    const t1 = performance.now();
    let linked = 0;
    const link = (path: string, code: string) => {
      const worker = linkers.reduce((a, b) => (b.pending < a.pending ? b : a));
      linked++;
      return worker.link(path, code);
    };
    try {
      const out = await buildApp(esbuild, {
        files: built,
        indexHtml: index,
        // As @angular/build defines them for a development build of a browser app.
        define: { ngJitMode: 'false', ngServerMode: 'false', ngI18nClosureMode: 'false' },
        nodeModules: Object.keys(host.index).map((p) => `/${p}`),
        readNodeModule: async (path) => {
          const bytes = await readNodeModule(host, path);
          if (!needsLinking(path)) return bytes;
          const code = new TextDecoder().decode(bytes);
          return code.includes('\u0275\u0275ngDeclare') ? new TextEncoder().encode(await link(path, code)) : bytes;
        },
      });
      assets = out.assets;
      html = out.html;
      for (const w of out.warnings) ctx.log('stderr', `[esbuild] ${w}`);
    } catch (e) {
      if (e instanceof BuildError) throw new AdapterError('APP', `build failed:\n${e.message}`);
      throw new AdapterError('INTERNAL', (e as Error).message);
    }
    ctx.log('stdout', `bundled in ${Math.round(performance.now() - t1)} ms (${assets.size} files; ${linked} library files linked)`);
  }


}

/** Library code that the Angular Linker may have to process: JavaScript in node_modules, except the compiler itself. */
function needsLinking(path: string): boolean {
  return /\.m?js$/.test(path) && !/\/node_modules\/@angular\/(compiler|compiler-cli|localize)\//.test(path);
}
