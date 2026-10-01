/**
 * How the node runtime installs and starts a project, worked out from its files alone: the dev
 * script, the packages of a project with client/ and server/ packages, and the plan for an install
 * in the page (ADR 0018). No Node.js imports: the demo site's generator page bundles it.
 */
import { expandScript, findFullStack, isTsRunner } from './scripts.ts';
import { extraDependencies } from './install-rules.ts';
import { detectFramework } from '../../framework.ts';
import type { Project } from '../../types.ts';
import type { HostInstall } from './browser.ts';

/**
 * How the project's dev (or start) script starts it: `node <file>` (or tsx/nodemon …), or a
 * package's CLI (vite, astro, …), following npm run / concurrently like a shell would.
 */
export function startCommand(project: Project): { file?: string; bin?: string; argv: string[]; command: string; tsRunner: boolean } | null {
  const scripts = project.packageJson?.scripts ?? {};
  const script = scripts.dev ?? scripts.start;
  if (script) {
    for (const leaf of expandScript(project.files, '', script)) {
      if (leaf.dir) continue; // another package's script: not this runtime's job
      const [cmd, ...args] = leaf.words;
      if (/^(node|nodemon|tsx|ts-node|ts-node-dev|esno)$/.test(cmd)) {
        const positional = args.filter((a) => !a.startsWith('-') && a !== 'watch');
        if (positional[0]) return { file: positional[0].replace(/^\.\//, ''), argv: positional.slice(1), command: leaf.command, tsRunner: isTsRunner(leaf.command) };
      } else if (/^[a-z@][\w@/.-]*$/i.test(cmd) && !/^(npm|npx|yarn|pnpm|bun|cd|echo|rm|cp|mkdir|concurrently|cross-env)$/.test(cmd)) {
        return { bin: cmd, argv: args, command: leaf.command, tsRunner: false };
      }
    }
  }
  if (typeof project.packageJson?.main === 'string') return { file: project.packageJson.main.replace(/^\.\//, ''), argv: [], command: `node ${project.packageJson.main}`, tsRunner: false };
  return null;
}

/** The package in `dir` as a project of its own (a client/ or server/ package). */
export function subProject(project: Project, dir: string): Project {
  if (!dir) return project;
  const prefix = `${dir}/`;
  const files: Project['files'] = {};
  for (const [path, content] of Object.entries(project.files)) if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
  let packageJson: Project['packageJson'] = null;
  try {
    packageJson = typeof files['package.json'] === 'string' ? JSON.parse(files['package.json']) : null;
  } catch {
    // reported by npm at install
  }
  return { ...project, name: `${project.name}/${dir}`, files, packageJson, framework: detectFramework(files, packageJson) };
}

export function devScript(project: Project): string | null {
  const scripts = project.packageJson?.scripts ?? {};
  return scripts.dev ?? scripts.start ?? null;
}

/**
 * Whether the dev script is one command in the project root that startCommand can start directly:
 * anything else (several commands, other packages' scripts, environment variables) runs through the
 * runtime's shell, as npm runs it through sh.
 */
export function isSimple(project: Project, script: string): boolean {
  const leaves = expandScript(project.files, '', script);
  return leaves.length === 1 && leaves[0].dir === '' && !/(^|\s)[A-Za-z_][A-Za-z0-9_]*=|\$/.test(script) && !/^(concurrently|npm-run-all|run-p|run-s)\b/.test(script.trim());
}

/** Directories (one level down) with a package.json of their own, unless the root's npm workspaces install them. */
export function packageDirs(project: Project): string[] {
  if (project.packageJson && 'workspaces' in project.packageJson) return [];
  return Object.keys(project.files)
    .map((p) => /^([^/]+)\/package\.json$/.exec(p)?.[1])
    .filter((d): d is string => !!d && d !== 'node_modules' && !d.startsWith('.'))
    .sort();
}

/**
 * An install the page does itself (opt-in, see node-runtime/npm/install.ts): what to install for each
 * package of the project, and how to start it. Package binaries are found after the install.
 */
export function browserInstall(project: Project): HostInstall {
  const part = (dir: string, p: Project) => ({
    dir,
    packageJson: { dependencies: p.packageJson?.dependencies, devDependencies: p.packageJson?.devDependencies, overrides: p.packageJson?.overrides as Record<string, unknown> | undefined },
    lockfile: typeof p.files['package-lock.json'] === 'string' ? (p.files['package-lock.json'] as string) : null,
    extra: dir ? {} : extraDependencies(p),
  });
  const parts = [part('', project)];
  for (const dir of packageDirs(project)) {
    const sub = subProject(project, dir);
    if (Object.keys({ ...sub.packageJson?.dependencies, ...sub.packageJson?.devDependencies }).length) parts.push(part(dir, sub));
  }
  let start: HostInstall['start'] = null;
  if (project.framework !== 'next') {
    const cmd = startCommand(project);
    const script = devScript(project);
    if (cmd && (!script || isSimple(project, script))) start = cmd.bin ? { bin: cmd.bin, argv: cmd.argv, command: cmd.command, tsRunner: cmd.tsRunner } : { main: cmd.file!, argv: cmd.argv, command: cmd.command, tsRunner: cmd.tsRunner };
    else if (script) start = { shell: script, command: script, tsRunner: false };
  }
  const proxy = project.framework === 'next' ? [] : findFullStack(project.files).proxy;
  // lockfile: set by the install in the page, to whether the lockfile decided the tree.
  return { key: '', index: {}, resolved: {}, lockfile: false, start, proxy, browserInstall: parts };
}

/** A static site (index.html, no package.json): no packages, a file server (see browser.ts). */
export function staticInstall(): HostInstall {
  return { key: '', index: {}, resolved: {}, lockfile: false, start: { main: '.sandburg/start.js', argv: [], command: 'a static file server', tsRunner: false } };
}

/** What a run that installs in the page needs to know to install and start a project (the generator page). */
export function pageInstall(project: Project): HostInstall {
  return project.framework === 'static' ? staticInstall() : browserInstall(project);
}
