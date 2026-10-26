/**
 * What Sandburg knows of each framework, by the name detection gives a project (`Framework`,
 * types.ts): one entry each, so that adding a framework is an entry here, its name in the
 * `Framework` union and in result-schema.json's enum (test/unit/frameworks.test.ts checks both
 * against this table). No Node.js imports: the host, the page, the runtime and the demo site's
 * generator page import it.
 *
 * What a framework needs of its packages is filed by package, not here, since other frameworks
 * share the packages: source patches and WebAssembly builds (adapters/node/install-rules.ts),
 * deferred imports (adapters/node/deferred-imports.ts). docs/architecture.md lists the rest.
 */
import type { FileTree, Framework, PackageJson } from './types.ts';

export interface FrameworkInfo {
  /** Its name, as people write it. */
  title: string;
  /** Whether a project uses it, from its dependencies and file paths. Tried in the table's order: the first match wins. */
  detect(deps: Record<string, string>, paths: string[], files: FileTree, pkg: PackageJson | null): boolean;
  /**
   * Directories at a project's root (or a package's) that it builds into or caches in: a thread's
   * snapshot of the project leaves them out, and they change while the app runs (node-runtime/threads.ts).
   */
  buildDirs?: string[];
  /** Its caches in node_modules (node_modules/<dir>): writes there are not the install changing (threads.ts). */
  nodeModulesCaches?: string[];
  /** Its dev server's dependency caches (project-relative), kept between runs of the same project (adapters/node/dev-cache.ts). */
  devCaches?: string[];
  /** Switches that turn off its telemetry and prompts: set for every program a run starts (adapters/node/scripts.ts' DEV_ENV). */
  quietEnv?: Record<string, string>;
  /** How the node runtime starts its dev server (adapters/node/browser.ts). */
  node?: {
    /** The runtime starts its spare runtimes for threads as the run mounts: its dev server starts threads. */
    sparesAtMount?: boolean;
    /** Its dev server's environment. */
    env?: Record<string, string>;
    /** Options for its dev command, when it would start more Node processes than the server needs (each is a runtime here). */
    devCommand?(command: string, argv: string[]): { execArgv: string[]; argv: string[] } | null;
  };
  /** How the Docker reference (reference/docker.ts) starts its dev server: the script and the arguments for where it listens. */
  reference?: { script(pkg: PackageJson | null): string; listen(host: string, port: number): string[] };
}

const configFile = (name: string) => (paths: string[]) => paths.some((p) => new RegExp(`^${name}\\.config\\.[cm]?[jt]s$`).test(p));

/** The frameworks, in the order detection tries them: the ones built on Vite before Vite. */
export const FRAMEWORKS: Record<Exclude<Framework, 'unknown'>, FrameworkInfo> = {
  next: {
    title: 'Next.js',
    detect: (deps, paths) => 'next' in deps || configFile('next')(paths),
    buildDirs: ['.next'],
    quietEnv: { NEXT_TELEMETRY_DISABLED: '1' },
    node: {
      /**
       * SWC's WebAssembly build (there is no native SWC in the browser), and next.config.ts loaded
       * with Node's own type stripping, as `--experimental-next-config-strip-types` does. The default
       * path transpiles it with SWC to CommonJS, which SWC's WebAssembly build stopped doing in
       * Next.js 16 (it leaves the module ESM).
       */
      env: { NEXT_TEST_WASM: '1', __NEXT_NODE_NATIVE_TS_LOADER_ENABLED: 'true' },
    },
    reference: { script: () => 'dev', listen: (host, port) => ['-H', host, '-p', String(port)] },
  },
  angular: {
    title: 'Angular',
    detect: (deps, _paths, files) => '@angular/core' in deps || 'angular.json' in files,
    buildDirs: ['.angular'],
    devCaches: ['.angular/cache'],
    quietEnv: { NG_CLI_ANALYTICS: 'false' },
    node: {
      sparesAtMount: true,
      /**
       * The Angular CLI compiles TypeScript on its own thread, not in a worker thread
       * (NG_BUILD_PARALLEL_TS=0; the same compilation and diagnostics). A worker thread here is
       * another runtime that loads TypeScript and the Angular compiler again (~1 s of a warm ng
       * serve), for little parallelism.
       */
      env: { NG_BUILD_PARALLEL_TS: '0' },
    },
    // Angular CLI projects have "start": "ng serve" and no "dev" script.
    reference: { script: (pkg) => (pkg?.scripts?.dev ? 'dev' : 'start'), listen: (host, port) => ['--host', host, '--port', String(port)] },
  },
  sveltekit: {
    title: 'SvelteKit',
    detect: (deps) => '@sveltejs/kit' in deps,
    buildDirs: ['.svelte-kit'],
    nodeModulesCaches: ['.svelte-kit'],
    node: { sparesAtMount: true },
  },
  astro: {
    title: 'Astro',
    detect: (deps, paths) => 'astro' in deps || configFile('astro')(paths),
    buildDirs: ['.astro'],
    nodeModulesCaches: ['.astro'],
    quietEnv: { ASTRO_TELEMETRY_DISABLED: '1' },
    node: { sparesAtMount: true },
  },
  nuxt: {
    title: 'Nuxt',
    detect: (deps, paths) => 'nuxt' in deps || configFile('nuxt')(paths),
    buildDirs: ['.nuxt', '.output'],
    devCaches: ['node_modules/.cache/vite'],
    quietEnv: { NUXT_TELEMETRY_DISABLED: '1' },
    node: {
      sparesAtMount: true,
      /**
       * `nuxt dev` serves from its own process, and once it is ready starts two more (its fork pool)
       * to restart in after a change to nuxt.config, while the app's page loads. With --no-fork it
       * restarts in its own process.
       */
      devCommand: (command, argv) => (/^(nuxt|nuxi)\s+dev(\s|$)/.test(command) && !argv.some((a) => /^--(no-)?fork(=|$)/.test(a)) ? { execArgv: [], argv: [...argv, '--no-fork'] } : null),
    },
  },
  'solid-start': {
    title: 'SolidStart',
    detect: (deps) => '@solidjs/start' in deps,
    buildDirs: ['.vinxi'],
    node: { sparesAtMount: true },
  },
  'react-router': {
    title: 'React Router',
    detect: (deps) => '@react-router/dev' in deps,
    node: {
      sparesAtMount: true,
      /**
       * `react-router dev` relaunches itself as a child process with --conditions=development unless
       * it has them (~2 s). It starts with them instead, as the child it would relaunch (without that
       * child's REACT_ROUTER_DEV_RESTARTED).
       */
      devCommand: (command, argv) => (/^react-router\s+dev(\s|$)/.test(command) ? { execArgv: ['--conditions=development'], argv } : null),
    },
  },
  vite: {
    title: 'Vite',
    detect: (deps, paths) => 'vite' in deps || configFile('vite')(paths),
    nodeModulesCaches: ['.vite'],
    devCaches: ['node_modules/.vite'],
    node: { sparesAtMount: true },
    reference: { script: () => 'dev', listen: (host, port) => ['--host', host, '--port', String(port), '--strictPort'] },
  },
  static: {
    title: 'a static site',
    detect: (_deps, _paths, files, pkg) => !pkg && 'index.html' in files,
  },
};

/** A framework's entry; none for 'unknown'. */
export function frameworkInfo(framework: Framework): FrameworkInfo | undefined {
  return framework === 'unknown' ? undefined : FRAMEWORKS[framework];
}

/** Which framework a project uses, from its dependencies and config files. */
export function detectFramework(files: FileTree, pkg: PackageJson | null): Framework {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const paths = Object.keys(files);
  for (const [name, info] of Object.entries(FRAMEWORKS) as [Exclude<Framework, 'unknown'>, FrameworkInfo][]) if (info.detect(deps, paths, files, pkg)) return name;
  return 'unknown';
}

/** Every framework's value of `field`, in the table's order. */
export function allOf<K extends 'buildDirs' | 'nodeModulesCaches' | 'devCaches'>(field: K): string[] {
  return Object.values(FRAMEWORKS).flatMap((f) => f[field] ?? []);
}
