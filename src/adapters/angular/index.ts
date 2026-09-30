/**
 * angular adapter (Node half, ADR 0008): Angular CLI apps, compiled AOT with
 * the app's own @angular/compiler-cli inside Sandburg's Node.js runtime
 * (ADR 0006) and bundled with esbuild-wasm (ADR 0007), all in the browser.
 * The host only installs dependencies (npm --ignore-scripts) and serves files.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, HostRequest, HostResponse, Project } from '../../types.ts';
import { NODE_VERSION } from '../../node-runtime/version.ts';
import { esbuildAdapter, serve as serveEsbuild, unsupportedPostcssPlugins } from '../esbuild/index.ts';
import { serve as serveNode } from '../node/index.ts';
import { sharedInstaller } from '../node/install.ts';
import { readAngularWorkspace } from './workspace.ts';

export interface AngularHostInstall {
  key: string;
  index: Record<string, number>;
  resolved: Record<string, string>;
  lockfile: boolean;
}

const DRIVER = fileURLToPath(new URL('./ngc-driver.cjs', import.meta.url));

/** Builders whose semantics this adapter reproduces (application builders; webpack's browser builder is close enough for a dev build). */
const BUILDERS = /^@angular(\/build|-devkit\/build-angular):(application|browser-esbuild|browser)$/;

async function serve(req: HostRequest): Promise<HostResponse | null> {
  if (req.path === '/__sandburg/angular/ngc.cjs') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await readFile(DRIVER) };
  }
  return (await serveNode(req)) ?? (await serveEsbuild(req));
}

export const angular: AdapterDescriptor = {
  name: 'angular',
  // The compiler is the app's own; this is the runtime it runs in and the bundler.
  version: `node ${NODE_VERSION} + esbuild-wasm ${esbuildAdapter.version}`,
  browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
  assets: { '/__sw__.js': fileURLToPath(new URL('../node/sw.js', import.meta.url)) },
  egress: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  crossOriginIsolation: false,
  // A cold npm install of an Angular CLI project is large; compiling runs TypeScript in the browser.
  timeouts: { install: 600_000, start: 240_000 },
  probe(project: Project) {
    if (project.framework !== 'angular') return { verdict: 'unsupported', reason: `framework "${project.framework}" is not supported by the angular adapter` };
    let build;
    try {
      build = readAngularWorkspace(project.files as Record<string, string>);
    } catch {
      // A broken angular.json is the app's problem; mount reports it as such.
      return { verdict: 'supported' };
    }
    if (!BUILDERS.test(build.builder)) return { verdict: 'unsupported', reason: `builder "${build.builder}" is not supported (supported: the Angular CLI application builders)` };
    const deps = { ...project.packageJson?.dependencies, ...project.packageJson?.devDependencies };
    if (!deps['@angular/compiler-cli']) return { verdict: 'unsupported', reason: '@angular/compiler-cli is not a dependency' };
    // Tailwind v4 (@tailwindcss/postcss) is applied by the bundle step; other PostCSS plugins are not run.
    const postcss = unsupportedPostcssPlugins(project);
    if (postcss.length) return { verdict: 'unsupported', reason: `PostCSS plugins are not run by the angular adapter: ${postcss.join(', ')}` };
    return { verdict: 'supported' };
  },
  async hostInstall(project, log): Promise<AngularHostInstall> {
    const installer = sharedInstaller();
    const info = await installer.install(project, {}, log);
    return { key: info.key, index: await installer.index(info.key), resolved: info.resolved, lockfile: info.lockfile };
  },
  serve,
};
