/**
 * Local packages' links (ADR 0064): a workspace package, or a `file:`/`link:` dependency, appears in
 * node_modules (`/app/node_modules/@acme/ui`) with its files, and resolves to its own directory
 * (`/app/packages/ui`), as npm's symlink does under Node: `fs.realpath` and module resolution give
 * the package's directory, so a module of it loads once, finds its dependencies from there, and a
 * dev server sees its sources as the project's (Vite does not pre-bundle a linked package).
 */

/** Link → target, absolute, longest link first. */
let links: [string, string][] = [];

/** The project's links (project-relative node_modules path → package directory) under `root`. */
export function setLinks(map: Record<string, string>, root: string): void {
  links = Object.entries(map)
    .map(([from, to]): [string, string] => [`${root}/${from}`, to ? `${root}/${to}` : root])
    .sort(([a], [b]) => b.length - a.length);
}

/** A path with a link at its start replaced by the link's target (normalized paths). */
export function realpath(path: string): string {
  for (const [from, to] of links) {
    if (path === from) return to;
    if (path.startsWith(from) && path[from.length] === '/') return to + path.slice(from.length);
  }
  return path;
}

/** Where the project's links and workspace packages are written for the runtime (browser.ts, worker.ts, shell.ts). */
export const WORKSPACE_FILE = '.sandburg/workspace.json';

/** What WORKSPACE_FILE holds. */
export interface WorkspaceInfo {
  links: Record<string, string>;
  /** Workspace packages: name → project-relative directory. */
  packages: Record<string, string>;
}

/** WORKSPACE_FILE's contents, or null (absent or broken). */
export function parseWorkspace(text: string | null): WorkspaceInfo | null {
  if (!text) return null;
  try {
    const w = JSON.parse(text) as Partial<WorkspaceInfo>;
    return { links: w.links ?? {}, packages: w.packages ?? {} };
  } catch {
    return null;
  }
}
