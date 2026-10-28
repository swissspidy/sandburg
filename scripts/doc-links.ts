/**
 * Checks the relative links in the README and docs/: each must name a file or directory that is
 * there and, with a #fragment into a Markdown file, one of its headings (as GitHub makes their
 * anchors). Links to other sites are not fetched. test/unit/doc-links.test.ts runs it.
 *
 *   node scripts/doc-links.ts [file.md …]   # default: README.md and docs/**\/*.md
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The Markdown files whose links are checked, relative to the repository. */
export function docFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []));
  return ['README.md', ...walk('docs')];
}

/** GitHub's anchor for a heading: lower case, punctuation but `-` and `_` dropped, spaces to `-`. */
export function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The anchors of a Markdown file's headings (outside code blocks), with GitHub's -1, -2 for repeats. */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** The link targets of a Markdown file (inline links and images), outside code. */
export function links(markdown: string): string[] {
  const text = markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '').replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
}

/** Broken links in `files` (relative to the repository), as "file: target (why)". */
export function brokenLinks(files: string[] = docFiles()): string[] {
  const broken: string[] = [];
  for (const file of files) {
    const markdown = readFileSync(join(ROOT, file), 'utf8');
    for (const target of links(markdown)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path, fragment] = target.split('#', 2) as [string, string | undefined];
      const abs = path ? resolve(ROOT, dirname(file), decodeURIComponent(path)) : join(ROOT, file);
      if (!abs.startsWith(ROOT) || !existsSync(abs)) {
        broken.push(`${file}: ${target} (no ${relative(ROOT, abs)})`);
        continue;
      }
      if (fragment === undefined || !abs.endsWith('.md') || statSync(abs).isDirectory()) continue;
      if (!anchors(readFileSync(abs, 'utf8')).has(fragment)) broken.push(`${file}: ${target} (no heading #${fragment})`);
    }
  }
  return broken;
}

if (import.meta.main) {
  const broken = brokenLinks(process.argv.length > 2 ? process.argv.slice(2) : undefined);
  for (const b of broken) console.error(b);
  console.log(broken.length ? `${broken.length} broken links` : 'no broken links');
  process.exitCode = broken.length ? 1 : 0;
}
