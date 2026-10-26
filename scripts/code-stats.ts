/**
 * Counts what the maintainability work tracks, from the syntax tree (oxc-parser), over src/:
 * type assertions (`as`, `as unknown as`, `<T>x`), non-null assertions, `catch` blocks with no
 * statement and no comment, and the longest modules.
 *
 *   node scripts/code-stats.ts [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';

type Node = { type: string; start: number; end: number; [k: string]: unknown };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const key in n) {
    if (key === 'parent') continue;
    const v = n[key];
    if (v && typeof v === 'object') walk(v, visit);
  }
}

const dir = process.argv[2] ?? 'src';
const totals = { as: 0, asUnknownAs: 0, angle: 0, nonNull: 0, emptyCatch: 0 };
const emptyCatches: string[] = [];
const sizes: [string, number][] = [];
for (const file of files(dir)) {
  const code = readFileSync(file, 'utf8');
  sizes.push([relative('.', file), code.split('\n').length - (code.endsWith('\n') ? 1 : 0)]);
  const r = parseSync(file, code);
  const comments = r.comments as unknown as Node[];
  walk(r.program, (n) => {
    if (n.type === 'TSAsExpression') {
      totals.as++;
      const inner = n.expression as Node;
      if (inner.type === 'TSAsExpression' && (inner.typeAnnotation as Node).type === 'TSUnknownKeyword') totals.asUnknownAs++;
    } else if (n.type === 'TSTypeAssertion') totals.angle++;
    else if (n.type === 'TSNonNullExpression') totals.nonNull++;
    else if (n.type === 'CatchClause') {
      const body = n.body as Node;
      if ((body.body as Node[]).length === 0 && !comments.some((c) => c.start >= body.start && c.end <= body.end)) {
        totals.emptyCatch++;
        emptyCatches.push(`${relative('.', file)}:${code.slice(0, n.start).split('\n').length}`);
      }
    }
  });
}
sizes.sort((a, b) => b[1] - a[1]);
console.log(`as casts: ${totals.as} (as unknown as: ${totals.asUnknownAs}), <T> casts: ${totals.angle}, non-null !: ${totals.nonNull}`);
console.log(`empty catch blocks without a comment: ${totals.emptyCatch}`);
for (const c of emptyCatches) console.log(`  ${c}`);
console.log('longest modules:');
for (const [f, n] of sizes.slice(0, 12)) console.log(`  ${String(n).padStart(5)} ${f}`);
