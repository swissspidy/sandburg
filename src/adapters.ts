import { angular } from './adapters/angular/index.ts';
import { esbuildAdapter } from './adapters/esbuild/index.ts';
import { node } from './adapters/node/index.ts';
import type { AdapterDescriptor, Project } from './types.ts';

/** Adapters by name. */
const registry: Record<string, AdapterDescriptor> = {
  angular,
  esbuild: esbuildAdapter,
  node,
};

/** The default runtime: the adapter that suits each project best (see chooseRuntime). */
export const AUTO = 'auto';
export const adapterNames = [AUTO, ...Object.keys(registry)];

export function getAdapter(name: string): AdapterDescriptor {
  const adapter = registry[name];
  if (!adapter) throw new Error(`unknown runtime "${name}" (available: ${adapterNames.join(', ')})`);
  return adapter;
}

/**
 * `--runtime auto` (ADR 0013). Angular CLI apps run in the angular adapter. Apps the esbuild build supports (client-side Vite apps, static
 * sites, and those with a Node backend next to them) use it: it is the fastest. Everything else
 * runs on the node runtime with the project's own dev server (Next.js, Vite with plugins, SvelteKit,
 * Astro, Nuxt, React Router, SolidStart, Node servers).
 */
export function chooseRuntime(project: Project): string {
  if (project.framework === 'angular') return 'angular';
  if (esbuildAdapter.probe(project).verdict === 'supported') return 'esbuild';
  return 'node';
}

/** The adapter for a runtime name, resolving `auto` for the project. */
export function adapterFor(name: string, project: Project): AdapterDescriptor {
  return getAdapter(name === AUTO ? chooseRuntime(project) : name);
}
