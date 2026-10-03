/**
 * The model's answer as file edits. It writes each file whole, between <file path="…"> and
 * </file>, and deletes with <delete path="…" />. The parser also reads an answer that is still
 * streaming: the file being written is `open`.
 */
import type { FileTree } from '../../src/types.ts';

export type FileEdit = { path: string; content: string } | { path: string; delete: true };

export interface ParsedAnswer {
  edits: FileEdit[];
  /** The file the model is writing (a streaming answer), and how much of it there is so far. */
  open: { path: string; chars: number } | null;
  /** What the model said outside the files. */
  prose: string;
  /** Paths the model used that a project cannot have (outside it, node_modules). */
  rejected: string[];
}

const TAG = /<file\s+path\s*=\s*"([^"]+)"\s*>|<delete\s+path\s*=\s*"([^"]+)"\s*\/?>/g;

export function parseAnswer(text: string): ParsedAnswer {
  const edits: FileEdit[] = [];
  const rejected: string[] = [];
  let prose = '';
  let open: ParsedAnswer['open'] = null;
  let at = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    prose += text.slice(at, m.index);
    const path = cleanPath(m[1] ?? m[2]);
    if (m[2] !== undefined) {
      at = TAG.lastIndex;
      if (path) edits.push({ path, delete: true });
      else rejected.push(m[2]);
      continue;
    }
    const start = TAG.lastIndex;
    const end = text.indexOf('</file>', start);
    if (end === -1) {
      open = { path: path ?? m[1], chars: text.length - start };
      at = text.length;
      break;
    }
    if (path) edits.push({ path, content: unfence(text.slice(start, end)) });
    else rejected.push(m[1]);
    at = TAG.lastIndex = end + '</file>'.length;
  }
  if (!open) prose += text.slice(at);
  return { edits, open, prose: prose.replace(/\n{3,}/g, '\n\n').trim(), rejected };
}

/** A project-relative path, or null for one outside the project or in node_modules. */
export function cleanPath(raw: string): string | null {
  const parts: string[] = [];
  for (const part of raw.trim().replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part === 'node_modules') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** File contents without the newline after the tag, and without a Markdown fence the model may have added. */
function unfence(content: string): string {
  let body = content.replace(/^\r?\n/, '');
  const fenced = /^\s*```[\w.+-]*[ \t]*\r?\n([\s\S]*?)\r?\n\s*```\s*$/.exec(body);
  if (fenced) body = fenced[1] + '\n';
  return body;
}

/** The project after the edits, and what changed. */
export function applyEdits(files: FileTree, edits: FileEdit[]): { files: FileTree; changed: string[]; deleted: string[] } {
  const next: FileTree = { ...files };
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const edit of edits) {
    if ('delete' in edit) {
      if (edit.path in next) {
        delete next[edit.path];
        deleted.push(edit.path);
      }
    } else if (next[edit.path] !== edit.content) {
      next[edit.path] = edit.content;
      changed.push(edit.path);
    }
  }
  return { files: next, changed: [...new Set(changed)], deleted };
}

/**
 * Whether the running app can take the change as it is (written into the runtime: the dev server
 * reloads it), or needs a new run: new packages, a deleted file, a dev server's or the backend's
 * own config or code.
 */
export function needsRestart(changed: string[], deleted: string[], framework = ''): boolean {
  if (deleted.length) return true;
  // A plain Node server (Express) has no watcher; Nuxt's server/ is Nitro's, which reloads itself.
  const serverCode = framework === 'nuxt' ? /^$/ : /^(server|api|backend)\//;
  return changed.some((p) => /(^|\/)package(-lock)?\.json$/.test(p) || /(^|\/)[\w-]+\.config\.[cm]?[jt]s$/.test(p) || /^angular\.json$|(^|\/)proxy\.conf\.json$/.test(p) || serverCode.test(p) || /^\.env/.test(p));
}

/** The project as the model sees it: every text file in the answer format. */
export function formatFiles(files: FileTree): string {
  return Object.keys(files)
    .sort()
    .filter((p) => typeof files[p] === 'string')
    .map((p) => `<file path="${p}">\n${files[p]}${(files[p] as string).endsWith('\n') ? '' : '\n'}</file>`)
    .join('\n\n');
}
