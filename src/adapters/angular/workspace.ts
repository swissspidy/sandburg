/**
 * Reads an Angular CLI workspace (angular.json) the way `ng serve` would pick
 * its build options: the default (or first) application project, the build
 * target's options merged with its development configuration.
 */
import { stripJsonComments } from '../esbuild/resolve.ts';

export interface AngularBuild {
  project: string;
  /** Project-relative paths. */
  main: string;
  tsConfig: string;
  index: string;
  /** Module specifiers or project files, in order. */
  polyfills: string[];
  /** Global stylesheets that are injected into the page, in order. */
  styles: string[];
  assets: { input: string; output: string }[];
  inlineStyleLanguage: string;
  includePaths: string[];
  builder: string;
}

type Json = Record<string, unknown>;

export function readAngularWorkspace(files: Record<string, string | Uint8Array>): AngularBuild {
  const text = files['angular.json'];
  if (typeof text !== 'string') throw new Error('angular.json is missing');
  const ws = JSON.parse(stripJsonComments(text)) as { projects?: Record<string, Json>; defaultProject?: string };
  const projects = ws.projects ?? {};
  const name =
    (ws.defaultProject && projects[ws.defaultProject] ? ws.defaultProject : undefined) ??
    Object.keys(projects).find((n) => projects[n].projectType === 'application') ??
    Object.keys(projects)[0];
  if (!name) throw new Error('angular.json has no projects');
  const project = projects[name] as { root?: string; sourceRoot?: string; architect?: Json; targets?: Json };
  const targets = (project.architect ?? project.targets ?? {}) as Record<string, { builder?: string; options?: Json; configurations?: Record<string, Json> }>;
  const build = targets.build;
  if (!build) throw new Error(`project "${name}" has no build target`);
  const serveConfig = (targets.serve?.options?.buildTarget as string | undefined)?.split(':')[2] ?? 'development';
  const options: Json = { ...build.options, ...build.configurations?.[serveConfig] };

  const root = (project.root ?? '').replace(/\/$/, '');
  const sourceRoot = (project.sourceRoot ?? (root ? `${root}/src` : 'src')).replace(/\/$/, '');
  const rel = (p: string) => p.replace(/^\.\//, '');
  const main = (options.browser ?? options.main) as string | undefined;
  if (!main) throw new Error(`project "${name}" has no browser/main entry`);
  const index = typeof options.index === 'string' ? options.index : ((options.index as Json | undefined)?.input as string | undefined) ?? `${sourceRoot}/index.html`;
  const polyfills = typeof options.polyfills === 'string' ? [options.polyfills] : ((options.polyfills as string[] | undefined) ?? []);
  const styles = ((options.styles as (string | { input: string; inject?: boolean })[] | undefined) ?? [])
    .filter((s) => typeof s === 'string' || s.inject !== false)
    .map((s) => rel(typeof s === 'string' ? s : s.input));
  const assets = ((options.assets as (string | { glob?: string; input: string; output?: string })[] | undefined) ?? []).map((a) => {
    if (typeof a === 'string') {
      // "src/favicon.ico" → /favicon.ico, "src/assets" → /assets (relative to the source root).
      const input = rel(a);
      const output = input.startsWith(`${sourceRoot}/`) ? input.slice(sourceRoot.length) : `/${input.split('/').pop()}`;
      return { input, output };
    }
    const output = `/${(a.output ?? '').replace(/^\/|\/$/g, '')}`;
    return { input: rel(a.input).replace(/\/$/, ''), output };
  });
  return {
    project: name,
    main: rel(main),
    tsConfig: rel((options.tsConfig as string | undefined) ?? 'tsconfig.app.json'),
    index: rel(index),
    polyfills,
    styles,
    assets,
    inlineStyleLanguage: (options.inlineStyleLanguage as string | undefined) ?? 'css',
    includePaths: ((options.stylePreprocessorOptions as Json | undefined)?.includePaths as string[] | undefined) ?? [],
    builder: build.builder ?? '',
  };
}
