/**
 * The package's public API, as one file: every declaration a consumer's TypeScript can reach from
 * the package's entry (dist/index.d.ts), and the declarations those name, without comments. The
 * report is checked in (api/sandburg.api.md) and compared by test/unit/api-report.test.ts, so an
 * API change is a reviewed change to that file, not an accident.
 *
 *   node scripts/api-report.ts            # print the report
 *   node scripts/api-report.ts --update   # write api/sandburg.api.md
 *
 * It emits the declarations (tsc -p tsconfig.build.json --emitDeclarationOnly) into a temporary
 * directory and walks them with oxc-parser from the entry's exports: a re-export to the module that
 * declares it, a declaration to the names its types refer to (in its module, or imported). A type
 * from another package is listed by name and package. Private members are left out (tsc emits
 * their names only; adding one is no API change), and so are comments (a doc edit is no API
 * change), but a public declaration with no doc comment is listed at the end, so that the count
 * shows.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

type Node = { type: string; start: number; end: number; [k: string]: unknown };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPORT = join(ROOT, 'api/sandburg.api.md');

interface Module {
  code: string;
  body: Node[];
  comments: Node[];
  /** Local name → its top-level declaration statement. */
  declared: Map<string, Node>;
  /** Local name → where it is imported from (a module file, or a package) and its name there. */
  imported: Map<string, { from: string; name: string }>;
  /** Exported name → local name, or a re-export from another module. */
  exported: Map<string, { local: string } | { from: string; name: string }>;
  /** `export * from` and `export type * from`. */
  star: string[];
}

function declaredNames(st: Node): string[] {
  const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? (st.declaration as Node | null) : st;
  if (!d) return [];
  const id = d.id as Node | null | undefined;
  if (id?.type === 'Identifier') return [id.name as string];
  if (d.type === 'VariableDeclaration') return (d.declarations as Node[]).flatMap((v) => ((v.id as Node).type === 'Identifier' ? [(v.id as Node).name as string] : []));
  return [];
}

const nameOf = (n: Node) => ((n.name ?? n.value) as string);

function load(file: string, cache: Map<string, Module>): Module {
  const known = cache.get(file);
  if (known) return known;
  const code = readFileSync(file, 'utf8');
  const r = parseSync(file, code);
  if (r.errors.length) throw new Error(`${file}: ${r.errors.map((e) => e.message).join('; ')}`);
  const body = r.program.body as unknown as Node[];
  const m: Module = { code, body, comments: r.comments as unknown as Node[], declared: new Map(), imported: new Map(), exported: new Map(), star: [] };
  const target = (spec: string) => (spec.startsWith('.') ? join(dirname(file), spec).replace(/\.ts$/, '.d.ts') : spec);
  for (const st of body) {
    for (const name of declaredNames(st)) {
      m.declared.set(name, st);
      if (st.type === 'ExportNamedDeclaration') m.exported.set(name, { local: name });
    }
    if (st.type === 'ImportDeclaration') {
      for (const s of st.specifiers as Node[]) {
        m.imported.set(nameOf(s.local as Node), { from: target((st.source as Node).value as string), name: s.type === 'ImportSpecifier' ? nameOf(s.imported as Node) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*' });
      }
    } else if (st.type === 'ExportNamedDeclaration' && !st.declaration) {
      for (const s of st.specifiers as Node[]) {
        const local = nameOf(s.local as Node);
        m.exported.set(nameOf(s.exported as Node), st.source ? { from: target((st.source as Node).value as string), name: local } : { local });
      }
    } else if (st.type === 'ExportAllDeclaration') {
      m.star.push(target((st.source as Node).value as string));
    }
  }
  cache.set(file, m);
  return m;
}

/** The names a declaration's types refer to. */
function referenced(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) referenced(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Node;
  const leftmost = (q: Node): Node => (q.type === 'TSQualifiedName' ? leftmost(q.left as Node) : q);
  if (n.type === 'TSTypeReference') out.add(nameOf(leftmost(n.typeName as Node)));
  else if (n.type === 'TSTypeQuery' && (n.exprName as Node).type !== 'TSImportType') out.add(nameOf(leftmost(n.exprName as Node)));
  else if ((n.type === 'TSClassImplements' || n.type === 'TSInterfaceHeritage') && (n.expression as Node).type === 'Identifier') out.add(nameOf(n.expression as Node));
  else if (n.type === 'ClassDeclaration' && (n.superClass as Node | null)?.type === 'Identifier') out.add(nameOf(n.superClass as Node));
  for (const key in n) if (key !== 'parent') referenced(n[key], out);
  return out;
}

/** A statement's text without comments, `export` and `declare`, its lines' indentation kept. */
function text(m: Module, st: Node): string {
  let s = '';
  let at = st.start;
  for (const c of m.comments.filter((c) => c.start >= st.start && c.end <= st.end).sort((a, b) => a.start - b.start)) {
    s += m.code.slice(at, c.start);
    at = c.end;
  }
  s += m.code.slice(at, st.end);
  return s
    .split('\n')
    // A private member is no API (tsc emits its name only): adding one is no change.
    .filter((line) => line.trim() !== '' && !/^\s+private [\w$]+;$/.test(line))
    .join('\n')
    .replace(/^export (default )?/, '')
    .replace(/^declare /, '');
}

function hasDoc(m: Module, st: Node): boolean {
  const before = m.code.slice(0, st.start);
  return m.comments.some((c) => c.end <= st.start && /^\s*$/.test(before.slice(c.end)) && c.type === 'Block' && m.code.startsWith('/**', c.start));
}

export function apiReport(dtsRoot: string): string {
  const cache = new Map<string, Module>();
  const entry = join(dtsRoot, 'index.d.ts');
  /** Declarations in the report: `file#name` → its text, under the name the package exports it by. */
  const decls = new Map<string, { name: string; file: string; text: string; documented: boolean; exported: boolean }>();
  const external = new Map<string, Set<string>>();
  const queue: { file: string; name: string; as?: string }[] = [];

  /** The module and local name that declare `name` as `file` exports it. */
  const resolveExport = (file: string, name: string, seen = new Set<string>()): { file: string; local: string } | null => {
    if (seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const m = load(file, cache);
    const e = m.exported.get(name);
    if (e && 'local' in e) return resolveLocal(file, e.local, seen);
    if (e) return e.from.endsWith('.d.ts') ? resolveExport(e.from, e.name, seen) : (addExternal(e.from, e.name), null);
    for (const s of m.star) {
      const found = resolveExport(s, name, seen);
      if (found) return found;
    }
    return null;
  };
  const resolveLocal = (file: string, local: string, seen = new Set<string>()): { file: string; local: string } | null => {
    const m = load(file, cache);
    if (m.declared.has(local)) return { file, local };
    const i = m.imported.get(local);
    if (!i) return null; // a global (Promise, Record, …) or a type parameter
    if (!i.from.endsWith('.d.ts')) return addExternal(i.from, i.name), null;
    return resolveExport(i.from, i.name, seen);
  };
  const addExternal = (pkg: string, name: string) => {
    if (!external.has(pkg)) external.set(pkg, new Set());
    external.get(pkg)!.add(name);
  };

  const publicNames = new Map<string, string>(); // file#local → exported name
  const exportedFrom = (file: string): string[] => {
    const m = load(file, cache);
    return [...m.exported.keys(), ...m.star.flatMap(exportedFrom)];
  };
  for (const name of exportedFrom(entry)) {
    const found = resolveExport(entry, name);
    if (found) {
      publicNames.set(`${found.file}#${found.local}`, name);
      queue.push({ file: found.file, name: found.local, as: name });
    }
  }
  while (queue.length) {
    const { file, name } = queue.shift()!;
    const key = `${file}#${name}`;
    if (decls.has(key)) continue;
    const m = load(file, cache);
    const st = m.declared.get(name)!;
    decls.set(key, { name, file: relative(dtsRoot, file).split(sep).join('/'), text: text(m, st), documented: hasDoc(m, st), exported: publicNames.has(key) });
    for (const ref of referenced(st)) {
      if (ref === name) continue;
      const found = resolveLocal(file, ref);
      if (found) queue.push({ file: found.file, name: found.local });
    }
  }

  const sorted = [...decls.entries()].sort(([, a], [, b]) => Number(b.exported) - Number(a.exported) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const lines = [
    '# The public API of sandburg',
    '',
    'Generated by `node scripts/api-report.ts --update` from the package\'s declarations, and compared by',
    'test/unit/api-report.test.ts: a change to this file is a change to the API. Exported by the',
    'package, then the declarations those refer to, by module.',
    '',
    '```ts',
  ];
  let file = '';
  let section = true;
  for (const [key, d] of sorted) {
    if (section && !d.exported) {
      lines.push('// --- referenced, not exported by the package ---', '');
      section = false;
      file = '';
    }
    if (d.file !== file) {
      lines.push(`// ${d.file.replace(/\.d\.ts$/, '.ts')}`);
      file = d.file;
    }
    const as = publicNames.get(key);
    if (as && as !== d.name) lines.push(`// exported as ${as}`);
    lines.push(d.text, '');
  }
  lines.push('// --- from other packages ---');
  for (const [pkg, names] of [...external].sort(([a], [b]) => a.localeCompare(b))) lines.push(`// ${pkg}: ${[...names].sort().join(', ')}`);
  const undocumented = sorted.filter(([, d]) => d.exported && !d.documented).map(([, d]) => d.name);
  lines.push('', `// --- exported without a doc comment (${undocumented.length}) ---`);
  if (undocumented.length) lines.push(`// ${undocumented.join(', ')}`);
  lines.push('```', '');
  return lines.join('\n');
}

/** Emits the declarations into a temporary directory and reports on them. */
export function currentApiReport(): string {
  const out = mkdtempSync(join(tmpdir(), 'sandburg-api-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'tsconfig.build.json'), '--emitDeclarationOnly', '--outDir', out], { cwd: ROOT, stdio: 'pipe' });
    return apiReport(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = currentApiReport();
  if (process.argv.includes('--update')) writeFileSync(REPORT, report);
  else process.stdout.write(report);
}
