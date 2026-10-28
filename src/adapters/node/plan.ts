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
import { installPlan, type InstallPlan } from './local-packages.ts';
import { workspacePatterns } from '../../workspaces.ts';

/**
 * How the project's dev (or start) script starts it: `node <file>` (or tsx/nodemon …), or a
 * package's CLI (vite, astro, …), following npm run / concurrently like a shell would.
 */
export function startCommand(project: Project): { file?: string; bin?: string; argv: string[]; command: string; tsRunner: boolean } | null {
  // A workspace package runs from its own directory, through the shell (devScript).
  if (project.app) return null;
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
  if (project.app) {
    // A workspace package (Project.app): its own dev or start script, in its directory.
    const app = subProject(project, project.app);
    const scripts = app.packageJson?.scripts ?? {};
    const name = scripts.dev !== undefined ? 'dev' : scripts.start !== undefined ? 'start' : null;
    const dir = /\s/.test(project.app) ? JSON.stringify(project.app) : project.app;
    if (name) return `npm --prefix ${dir} run ${name}`;
    return typeof app.packageJson?.main === 'string' ? `cd ${dir} && node ${app.packageJson.main}` : null;
  }
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

/**
 * Directories (one level down) with a package.json of their own, installed as projects of their own:
 * not in a monorepo (its workspaces are installed with its root), and not a local package the root
 * links (`local`, installPlan's).
 */
export function packageDirs(project: Project, local: string[] = []): string[] {
  if (workspacePatterns(project.files, project.packageJson)) return [];
  return Object.keys(project.files)
    .map((p) => /^([^/]+)\/package\.json$/.exec(p)?.[1])
    .filter((d): d is string => !!d && d !== 'node_modules' && !d.startsWith('.') && !local.includes(d))
    .sort();
}

/**
 * The project as npm installs it at its root (installPlan, local-packages.ts): its registry
 * dependencies and its local packages', and its package-lock.json without their entries.
 */
export function rootInstall(project: Project, plan: InstallPlan): Project {
  const files: Project['files'] = plan.lockfile === null ? {} : { 'package-lock.json': plan.lockfile };
  return { ...project, files, packageJson: { ...project.packageJson, ...plan.root } };
}

/** What the runtime needs to know of a project's local packages (links.ts' WORKSPACE_FILE), or nothing when it has none. */
export function workspaceInfo(plan: InstallPlan): Pick<HostInstall, 'links' | 'workspaces'> {
  return Object.keys(plan.links).length || Object.keys(plan.workspaces).length ? { links: plan.links, workspaces: plan.workspaces } : {};
}

/** A line for the run's log about the versions a pnpm-lock.yaml or yarn.lock decided, or null. */
export function pinnedNote(plan: InstallPlan): string | null {
  return plan.pinned ? `${plan.pinned}: dependencies installed at the versions it locks (no package-lock.json)` : null;
}

/**
 * An install the page does itself (opt-in, see browser-npm/install.ts): what to install for each
 * package of the project, and how to start it. Package binaries are found after the install.
 */
export function browserInstall(project: Project): HostInstall {
  const part = (dir: string, p: Pick<Project, 'files' | 'packageJson'>) => ({
    dir,
    packageJson: { dependencies: p.packageJson?.dependencies, devDependencies: p.packageJson?.devDependencies, overrides: p.packageJson?.overrides as Record<string, unknown> | undefined },
    lockfile: typeof p.files['package-lock.json'] === 'string' ? p.files['package-lock.json'] : null,
    extra: dir ? {} : extraDependencies(p),
  });
  const plan = installPlan(project.files, project.packageJson);
  const parts = [part('', rootInstall(project, plan))];
  for (const { dir, dependencies } of plan.nested) parts.push(part(dir, { files: {}, packageJson: { dependencies } }));
  for (const dir of packageDirs(project, plan.local)) {
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
  // lockfile: set by the install in the page, to whether the lockfile decided the tree (or, here,
  // whether a pnpm-lock.yaml or yarn.lock pinned the versions).
  return { key: '', index: {}, resolved: {}, lockfile: plan.pinned !== null, start, proxy, browserInstall: parts, ...workspaceInfo(plan) };
}

/** A static site (index.html, no package.json): no packages, a file server (see browser.ts). */
export function staticInstall(): HostInstall {
  return { key: '', index: {}, resolved: {}, lockfile: false, start: { main: '.sandburg/start.js', argv: [], command: 'a static file server', tsRunner: false } };
}

/** What a run that installs in the page needs to know to install and start a project (the generator page). */
export function pageInstall(project: Project): HostInstall {
  return project.framework === 'static' ? staticInstall() : browserInstall(project);
}
