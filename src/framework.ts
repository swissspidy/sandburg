/** Which framework a project uses, from its dependencies and config files. No Node.js imports: the demo site's generator page bundles it. */
import type { FileTree, Framework, PackageJson } from './types.ts';

export function detectFramework(files: FileTree, pkg: PackageJson | null): Framework {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const paths = Object.keys(files);
  if ('next' in deps || paths.some((p) => /^next\.config\.[cm]?[jt]s$/.test(p))) return 'next';
  if ('@angular/core' in deps || 'angular.json' in files) return 'angular';
  if ('@sveltejs/kit' in deps) return 'sveltekit';
  if ('astro' in deps || paths.some((p) => /^astro\.config\.[cm]?[jt]s$/.test(p))) return 'astro';
  if ('nuxt' in deps || paths.some((p) => /^nuxt\.config\.[cm]?[jt]s$/.test(p))) return 'nuxt';
  if ('@solidjs/start' in deps) return 'solid-start';
  if ('@react-router/dev' in deps) return 'react-router';
  if ('vite' in deps || paths.some((p) => /^vite\.config\.[cm]?[jt]s$/.test(p))) return 'vite';
  if (!pkg && 'index.html' in files) return 'static';
  return 'unknown';
}
