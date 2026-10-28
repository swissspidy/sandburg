/**
 * Moves top-level declarations from one module to another, as is: no edit to the code moved, only
 * to imports and exports. It redoes a module split on top of other changes to the same file (the
 * split of worker.ts, scripts/split-worker.ts, re-applied after other branches merge).
 *
 *   node scripts/split-module.ts <from.ts> <to.ts> [--doc "<header comment>"] <name|stmt:<prefix>>...
 *
 * - `name`: the statement that declares it (a function, class, variable, type or interface), with
 *   the comments right above it. A statement declaring several names moves when one is named, and
 *   must name only names asked for.
 * - `stmt:<prefix>`: a top-level expression statement whose text starts with `<prefix>` (a
 *   registration such as `netLinks.connect = …`).
 * - The target gets the imports the moved code uses (from the source's imports, or from the source
 *   for what stays there, which the source then exports); the source imports what it still uses of
 *   what moved, and drops imports it no longer uses. Files in the repository that imported a moved
 *   name from the source import it from the target.
 * - Statements run in the order they ran: moved statements keep their order in the target, and
 *   the target is evaluated before the source's body (it is imported by it), so only declarations
 *   and registrations that run nothing at evaluation should move.
 *
 * Checks afterwards: npm run typecheck and npm run lint.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

type Node = { type: string; start: number; end: number; [k: string]: unknown };
interface Spec {
  kind: 'default' | 'namespace' | 'named';
  local: string;
  imported: string;
  typeOnly: boolean;
}
interface ImportInfo {
  node: Node;
  source: string;
  specs: Spec[];
  typeOnly: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parse(path: string, code: string): { body: Node[]; comments: Node[] } {
  const r = parseSync(path, code);
  if (r.errors.length) throw new Error(`${path}: ${r.errors.map((e) => e.message).join('; ')}`);
  return { body: r.program.body as unknown as Node[], comments: r.comments as unknown as Node[] };
}

/** The names a top-level statement declares. */
function declared(st: Node): string[] {
  const d = st.type === 'ExportNamedDeclaration' && st.declaration ? (st.declaration as Node) : st;
  const id = (n: unknown) => ((n as Node | null)?.type === 'Identifier' ? [(n as { name: string }).name] : []);
  switch (d.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSEnumDeclaration':
      return id(d.id);
    case 'VariableDeclaration':
      return (d.declarations as Node[]).flatMap((v) => id(v.id));
    default:
      return [];
  }
}

function imports(body: Node[]): ImportInfo[] {
  return body
    .filter((st) => st.type === 'ImportDeclaration')
    .map((st) => ({
      node: st,
      source: (st.source as { value: string }).value,
      typeOnly: st.importKind === 'type',
      specs: (st.specifiers as Node[]).map((s) => ({
        kind: s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named',
        local: (s.local as { name: string }).name,
        imported: s.type === 'ImportSpecifier' ? ((s.imported as { name?: string; value?: string }).name ?? (s.imported as { value: string }).value) : '',
        typeOnly: st.importKind === 'type' || s.importKind === 'type',
      })),
    }));
}

/** The names a binding pattern declares. */
function bindings(pattern: unknown, out: string[] = []): string[] {
  const p = pattern as Node | null;
  if (!p) return out;
  if (p.type === 'Identifier') out.push((p as unknown as { name: string }).name);
  else if (p.type === 'ObjectPattern') for (const prop of p.properties as Node[]) bindings(prop.type === 'RestElement' ? prop.argument : prop.value, out);
  else if (p.type === 'ArrayPattern') for (const el of p.elements as Node[]) bindings(el, out);
  else if (p.type === 'AssignmentPattern') bindings(p.left, out);
  else if (p.type === 'RestElement') bindings(p.argument, out);
  else if (p.type === 'TSParameterProperty') bindings(p.parameter, out);
  return out;
}

/** The names a block's statements declare (let, const, var, function, class: hoisted to the block). */
function blockBindings(statements: Node[]): string[] {
  const out: string[] = [];
  for (const raw of statements) {
    const st = raw.type === 'ExportNamedDeclaration' && raw.declaration ? (raw.declaration as Node) : raw;
    if (st.type === 'VariableDeclaration') for (const d of st.declarations as Node[]) bindings(d.id, out);
    else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) bindings(st.id, out);
  }
  return out;
}

/**
 * The free identifiers of some code: those it refers to and does not declare itself (scopes are
 * followed: a local of the same name as a top-level declaration is not a reference to it). Type
 * names count as identifiers too, which is what imports need.
 */
function references(node: unknown, out = new Set<string>(), scope: Set<string>[] = []): Set<string> {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) references(n, out, scope);
    return out;
  }
  const n = node as Node;
  const bound = (name: string) => scope.some((s) => s.has(name));
  const walk = (v: unknown, inner = scope) => references(v, out, inner);
  const withScope = (names: string[]) => [...scope, new Set(names)];
  /** A pattern's defaults and computed keys are references; its names are not. */
  const patternRefs = (p: unknown, inner: Set<string>[]) => {
    const q = p as Node | null;
    if (!q) return;
    if (q.type === 'ObjectPattern') for (const prop of q.properties as Node[]) {
      if (prop.type === 'RestElement') patternRefs(prop.argument, inner);
      else {
        if (prop.computed) walk(prop.key, inner);
        patternRefs(prop.value, inner);
      }
    }
    else if (q.type === 'ArrayPattern') for (const el of q.elements as Node[]) patternRefs(el, inner);
    else if (q.type === 'AssignmentPattern') {
      patternRefs(q.left, inner);
      walk(q.right, inner);
    } else if (q.type === 'RestElement') patternRefs(q.argument, inner);
    else if (q.type === 'TSParameterProperty') patternRefs(q.parameter, inner);
    else if (q.type === 'Identifier' && q.typeAnnotation) walk(q.typeAnnotation, inner);
    if (q.type !== 'Identifier' && q.typeAnnotation) walk(q.typeAnnotation, inner);
  };
  switch (n.type) {
    case 'Identifier':
    case 'JSXIdentifier': {
      const name = (n as unknown as { name: string }).name;
      if (!bound(name)) out.add(name);
      return out;
    }
    case 'Program':
    case 'BlockStatement':
    case 'StaticBlock':
    case 'TSModuleBlock': {
      const body = n.body as Node[];
      for (const st of body) walk(st, withScope(blockBindings(body)));
      return out;
    }
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const params = n.params as Node[];
      const typeParams = ((n.typeParameters as { params?: Node[] } | null)?.params ?? []).map((t) => (t.name as { name: string }).name);
      const own = n.type === 'FunctionExpression' && n.id ? bindings(n.id) : [];
      const inner = withScope([...params.flatMap((p) => bindings(p)), ...typeParams, ...own, 'arguments']);
      for (const p of params) patternRefs(p, inner);
      walk(n.returnType, inner);
      const body = n.body as Node;
      if (body?.type === 'BlockStatement') for (const st of body.body as Node[]) walk(st, [...inner, new Set(blockBindings(body.body as Node[]))]);
      else walk(body, inner);
      return out;
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const typeParams = ((n.typeParameters as { params?: Node[] } | null)?.params ?? []).map((t) => (t.name as { name: string }).name);
      const inner = withScope([...(n.id ? bindings(n.id) : []), ...typeParams]);
      walk(n.superClass, inner);
      walk(n.superTypeArguments ?? n.superTypeParameters, inner);
      walk(n.implements, inner);
      walk(n.body, inner);
      return out;
    }
    case 'VariableDeclarator':
      patternRefs(n.id, scope);
      walk(n.init);
      return out;
    case 'CatchClause': {
      const inner = withScope(n.param ? bindings(n.param) : []);
      walk(n.body, inner);
      return out;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = (n.type === 'ForStatement' ? n.init : n.left) as Node | null;
      const names = head?.type === 'VariableDeclaration' ? (head.declarations as Node[]).flatMap((d) => bindings(d.id)) : [];
      const inner = withScope(names);
      for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') walk(v, inner);
      return out;
    }
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration': {
      const typeParams = ((n.typeParameters as { params?: Node[] } | null)?.params ?? []).map((t) => (t.name as { name: string }).name);
      const inner = withScope(typeParams);
      for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end' && k !== 'id') walk(v, inner);
      return out;
    }
    case 'TSMappedType': {
      const tp = (n.typeParameter as Node | undefined) ?? null;
      const name = (n.key as { name?: string } | undefined)?.name ?? (tp?.name as { name: string } | undefined)?.name;
      const inner = withScope(name ? [name] : []);
      for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end' && k !== 'key') walk(v, inner);
      return out;
    }
    case 'TSInferType':
      return out;
    // Type-level signatures: their parameter names are not references, their types are.
    case 'TSMethodSignature':
    case 'TSFunctionType':
    case 'TSConstructorType':
    case 'TSCallSignatureDeclaration':
    case 'TSConstructSignatureDeclaration':
    case 'TSDeclareFunction': {
      const params = (n.params as Node[] | undefined) ?? [];
      const typeParams = ((n.typeParameters as { params?: Node[] } | null)?.params ?? []).map((t) => (t.name as { name: string }).name);
      const inner = withScope([...params.flatMap((q) => bindings(q)), ...typeParams]);
      for (const q of params) patternRefs(q, inner);
      walk(n.returnType, inner);
      if (n.type === 'TSMethodSignature' && n.computed) walk(n.key, inner);
      return out;
    }
  }
  for (const [key, value] of Object.entries(n)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if ((n.type === 'MemberExpression' || n.type === 'StaticMemberExpression') && key === 'property' && !n.computed) continue;
    if ((n.type === 'Property' || n.type === 'PropertyDefinition' || n.type === 'MethodDefinition' || n.type === 'TSPropertySignature' || n.type === 'TSMethodSignature' || n.type === 'AccessorProperty') && key === 'key' && !n.computed && !n.shorthand) continue;
    if (n.type === 'TSQualifiedName' && key === 'right') continue;
    if ((n.type === 'LabeledStatement' || n.type === 'BreakStatement' || n.type === 'ContinueStatement') && key === 'label') continue;
    if (n.type === 'TSEnumMember' && key === 'id') continue;
    if (n.type === 'ImportExpression' && key === 'options') continue;
    references(value, out, scope);
  }
  return out;
}

/** The source range of statement i: from the first comment above it (after the previous statement) to its line's end. */
function range(code: string, body: Node[], comments: Node[], i: number): [number, number] {
  const st = body[i];
  const prevEnd = i > 0 ? body[i - 1].end : 0;
  let start = st.start;
  for (const c of [...comments].reverse()) {
    if (c.end > start || c.start < prevEnd) continue;
    // Only comments on the lines right above (nothing but whitespace between).
    if (/\S/.test(code.slice(c.end, start))) break;
    if (code.slice(c.end, start).split('\n').length > 2) break;
    // A comment that ends the previous statement's line belongs to that statement.
    if (!code.slice(prevEnd, c.start).includes('\n') && i > 0) break;
    start = c.start;
  }
  const lineStart = code.lastIndexOf('\n', start - 1) + 1;
  let end = code.indexOf('\n', st.end);
  end = end < 0 ? code.length : end + 1;
  // A trailing comment on the statement's last line comes along (the line moves whole).
  return [lineStart, end];
}

function importLine(names: Spec[], from: string): string {
  const def = names.find((s) => s.kind === 'default');
  const ns = names.find((s) => s.kind === 'namespace');
  const named = names.filter((s) => s.kind === 'named');
  const allTypes = names.every((s) => s.typeOnly);
  const spec = (s: Spec) => `${!allTypes && s.typeOnly ? 'type ' : ''}${s.imported === s.local ? s.local : `${s.imported} as ${s.local}`}`;
  const parts: string[] = [];
  if (def) parts.push(def.local);
  if (ns) parts.push(`* as ${ns.local}`);
  if (named.length) parts.push(`{ ${named.map(spec).join(', ')} }`);
  return `import ${allTypes ? 'type ' : ''}${parts.join(', ')} from '${from}';\n`;
}

/** A relative import path from file `from` to file `to`. */
function relImport(from: string, to: string): string {
  const r = relative(dirname(from), to).split('\\').join('/');
  return r.startsWith('.') ? r : `./${r}`;
}

/** The module an import path in `file` names, as an absolute path (null for packages). */
function resolveImport(file: string, path: string): string | null {
  return path.startsWith('.') ? resolve(dirname(file), path) : null;
}

/** Inserts lines after the last import (or at `fallback`). */
function addImports(code: string, body: Node[], lines: string[], fallback: number): string {
  if (!lines.length) return code;
  const last = body.filter((st) => st.type === 'ImportDeclaration').at(-1);
  const at = last ? code.indexOf('\n', last.end) + 1 : fallback;
  return code.slice(0, at) + lines.join('') + code.slice(at);
}

/** Adds an import of `specs` from `path` to a module: into its import from `path` of the same kind (type or not), if it has one. */
function mergeImport(code: string, file: string, specs: Spec[], path: string): string {
  if (!specs.length) return code;
  const { body } = parse(file, code);
  const allTypes = specs.every((s) => s.typeOnly);
  const same = imports(body).find((i) => i.source === path && i.typeOnly === allTypes && !i.specs.some((s) => s.kind !== 'named'));
  if (!same) return addImports(code, body, [importLine(specs, path)], 0);
  const merged = [...same.specs.map((s) => ({ ...s, typeOnly: s.typeOnly || same.typeOnly })), ...specs.filter((s) => !same.specs.some((x) => x.local === s.local))];
  const end = code.indexOf('\n', same.node.end) + 1;
  return code.slice(0, same.node.start) + importLine(merged, path) + code.slice(end);
}

export function splitModule(fromPath: string, toPath: string, names: string[], doc?: string): void {
  const from = resolve(fromPath);
  const to = resolve(toPath);
  let code = readFileSync(from, 'utf8');
  const { body, comments } = parse(from, code);

  // What moves.
  const wanted = new Set(names.filter((n) => !n.startsWith('stmt:')));
  const prefixes = names.filter((n) => n.startsWith('stmt:')).map((n) => n.slice(5));
  const moving: number[] = [];
  const found = new Set<string>();
  body.forEach((st, i) => {
    const decl = declared(st);
    if (decl.some((d) => wanted.has(d))) {
      const extra = decl.filter((d) => !wanted.has(d));
      if (extra.length) throw new Error(`${decl.join(', ')} are declared together: name ${extra.join(', ')} too`);
      decl.forEach((d) => found.add(d));
      moving.push(i);
    } else if (st.type === 'ExpressionStatement') {
      const text = code.slice(st.start, st.end);
      const p = prefixes.find((x) => text.startsWith(x));
      if (p !== undefined) {
        found.add(`stmt:${p}`);
        moving.push(i);
      }
    }
  });
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) throw new Error(`not found at the top level of ${fromPath}: ${missing.join(', ')}`);
  const movedNames = new Set([...found].filter((n) => !n.startsWith('stmt:')));

  const ranges = moving.map((i) => range(code, body, comments, i));
  const movedText = ranges.map(([s, e]) => code.slice(s, e)).join('\n').replace(/\n{3,}/g, '\n\n');
  const movedRefs = references(moving.map((i) => body[i]));

  // Declarations that stay in the source, by name.
  const staying = new Map<string, Node>();
  body.forEach((st, i) => {
    if (!moving.includes(i)) for (const d of declared(st)) staying.set(d, st);
  });

  // The target's imports: from the source's imports, and from the source itself.
  const sourceImports = imports(body);
  const targetImports = new Map<string, Spec[]>();
  const need = (path: string, spec: Spec) => {
    const list = targetImports.get(path) ?? [];
    if (!list.some((s) => s.local === spec.local)) list.push(spec);
    targetImports.set(path, list);
  };
  for (const imp of sourceImports) {
    for (const s of imp.specs) {
      if (!movedRefs.has(s.local)) continue;
      const abs = resolveImport(from, imp.source);
      need(abs ? (abs === to ? '' : relImport(to, abs)) : imp.source, s);
    }
  }
  const toExport = new Set<string>();
  for (const name of movedRefs) {
    if (movedNames.has(name) || !staying.has(name)) continue;
    toExport.add(name);
    const st = staying.get(name)!;
    const typeOnly = /^TS(TypeAlias|Interface)Declaration$/.test(st.type === 'ExportNamedDeclaration' ? (st.declaration as Node).type : st.type);
    need(relImport(to, from), { kind: 'named', local: name, imported: name, typeOnly });
  }
  targetImports.delete('');

  // The source without what moved; exports added to what the target uses.
  let rest = '';
  let at = 0;
  for (const [s, e] of ranges) {
    rest += code.slice(at, s);
    at = e;
  }
  rest += code.slice(at);
  rest = rest.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
  code = rest;
  {
    const parsed = parse(from, code);
    const edits: number[] = [];
    for (const st of parsed.body) {
      if (st.type === 'ExportNamedDeclaration') continue;
      if (declared(st).some((d) => toExport.has(d))) edits.push(st.start);
    }
    for (const pos of edits.sort((a, b) => b - a)) code = `${code.slice(0, pos)}export ${code.slice(pos)}`;
  }

  // Imports in the source: what it still uses of what moved; none it no longer uses.
  {
    const parsed = parse(from, code);
    const nonImports = parsed.body.filter((st) => st.type !== 'ImportDeclaration');
    const used = references(nonImports);
    // Type-only uses count too (the walk sees type references as identifiers).
    const back: Spec[] = [];
    for (const name of movedNames) {
      if (!used.has(name)) continue;
      const moved = body.find((st) => declared(st).includes(name))!;
      const kind = moved.type === 'ExportNamedDeclaration' ? (moved.declaration as Node).type : moved.type;
      back.push({ kind: 'named', local: name, imported: name, typeOnly: /^TS(TypeAlias|Interface)Declaration$/.test(kind) });
    }
    // Drop unused import specifiers (whole declarations when none is left).
    const cuts: [number, number, string][] = [];
    for (const imp of imports(parsed.body)) {
      const keep = imp.specs.filter((s) => used.has(s.local));
      if (keep.length === imp.specs.length) continue;
      const end = code.indexOf('\n', imp.node.end) + 1;
      cuts.push([imp.node.start, end, keep.length ? importLine(keep.map((s) => ({ ...s, typeOnly: s.typeOnly || imp.typeOnly })), imp.source) : '']);
    }
    for (const [s, e, text] of cuts.sort((a, b) => b[0] - a[0])) code = code.slice(0, s) + text + code.slice(e);
    code = mergeImport(code, from, back, relImport(from, to));
  }

  // The moved declarations are exported from the target when anything outside it uses them.
  const usedOutside = new Set<string>();
  {
    const parsedRest = parse(from, code);
    const restRefs = references(parsedRest.body.filter((st) => st.type !== 'ImportDeclaration'));
    for (const n of movedNames) if (restRefs.has(n)) usedOutside.add(n);
  }
  const repoFiles = execFileSync('git', ['ls-files', '*.ts', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/^(fixtures|corpus|integrations\/harbor\/tasks)\//.test(f))
    .map((f) => resolve(ROOT, f))
    .filter((f) => f !== from && f !== to);
  const importers: string[] = [];
  const dynamicImporters: string[] = [];
  for (const file of repoFiles) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(basename(from))) continue;
    // A file that imports the source with import() (a test that sets the environment first) may use
    // any moved name it mentions: those stay exported, and the file is named for its author to update.
    const dynamic = [...text.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)].some((m) => resolveImport(file, m[2]) === from);
    if (dynamic) {
      // As a property of the module (`node.name`) or destructured from it (`{ a, name } = await import(…)`).
      const mentioned = [...movedNames].filter((n) => new RegExp(`\\.${n.replace(/\$/g, '\\$')}\\b|[{,]\\s*${n.replace(/\$/g, '\\$')}\\s*[,}:]`).test(text));
      for (const n of mentioned) usedOutside.add(n);
      if (mentioned.length) dynamicImporters.push(`${relative(ROOT, file)} (${mentioned.join(', ')})`);
    }
    const { body: b } = parse(file, text);
    for (const imp of imports(b)) {
      if (resolveImport(file, imp.source) !== from) continue;
      const movedSpecs = imp.specs.filter((s) => s.kind === 'named' && movedNames.has(s.imported));
      if (!movedSpecs.length) continue;
      for (const s of movedSpecs) usedOutside.add(s.imported);
      importers.push(file);
    }
  }

  // The target: its imports, then what moved (exported where used elsewhere).
  const targetParsed = parse(to, movedText);
  let moved = movedText;
  {
    const edits: number[] = [];
    const unexport: number[] = [];
    for (const st of targetParsed.body) {
      const outside = declared(st).some((d) => usedOutside.has(d));
      // An export nothing imports any more (the source was an entry point, whose exports count as used).
      if (st.type === 'ExportNamedDeclaration') {
        if (!outside && st.declaration) unexport.push(st.start);
      } else if (outside) edits.push(st.start);
    }
    for (const pos of [...edits, ...unexport].sort((a, b) => b - a)) {
      moved = unexport.includes(pos) ? moved.slice(0, pos) + moved.slice(pos).replace(/^export /, '') : `${moved.slice(0, pos)}export ${moved.slice(pos)}`;
    }
  }
  const lines = [...targetImports].map(([path, specs]) => importLine(specs, path));
  if (existsSync(to)) {
    let target = readFileSync(to, 'utf8');
    const tp = parse(to, target);
    const have = imports(tp.body);
    const fresh = lines.filter((_, i) => {
      const [path, specs] = [...targetImports][i];
      return !have.some((h) => h.source === path && specs.every((s) => h.specs.some((x) => x.local === s.local)));
    });
    for (const [path, specs] of targetImports) {
      if (fresh.includes(importLine(specs, path))) target = mergeImport(target, to, specs, path);
    }
    // What the target imported of the moved names from the source is its own now.
    const cuts: [number, number, string][] = [];
    for (const imp of imports(parse(to, target).body)) {
      if (resolveImport(to, imp.source) !== from) continue;
      const keep = imp.specs.filter((s) => !(s.kind === 'named' && movedNames.has(s.imported)));
      if (keep.length === imp.specs.length) continue;
      const end = target.indexOf('\n', imp.node.end) + 1;
      cuts.push([imp.node.start, end, keep.length ? importLine(keep.map((s) => ({ ...s, typeOnly: s.typeOnly || imp.typeOnly })), imp.source) : '']);
    }
    for (const [s, e, t] of cuts.sort((a, b) => b[0] - a[0])) target = target.slice(0, s) + t + target.slice(e);
    writeFileSync(to, `${target.replace(/\n*$/, '\n')}\n${moved.replace(/^\n+/, '').replace(/\n*$/, '\n')}`);
  } else {
    const header = doc ? `/**\n${doc.split('\n').map((l) => ` * ${l}`.trimEnd()).join('\n')}\n */\n` : '';
    writeFileSync(to, `${header}${lines.join('')}${lines.length ? '\n' : ''}${moved.replace(/^\n+/, '').replace(/\n*$/, '\n')}`);
  }
  writeFileSync(from, code);

  // Importers of moved names import them from the target.
  for (const file of [...new Set(importers)]) {
    let text = readFileSync(file, 'utf8');
    const { body: b } = parse(file, text);
    const edits: [number, number, string][] = [];
    const add: Spec[] = [];
    for (const imp of imports(b)) {
      if (resolveImport(file, imp.source) !== from) continue;
      const movedSpecs = imp.specs.filter((s) => s.kind === 'named' && movedNames.has(s.imported));
      if (!movedSpecs.length) continue;
      const keep = imp.specs.filter((s) => !movedSpecs.includes(s));
      const end = text.indexOf('\n', imp.node.end) + 1;
      const typed = (s: Spec) => ({ ...s, typeOnly: s.typeOnly || imp.typeOnly });
      edits.push([imp.node.start, end, keep.length ? importLine(keep.map(typed), imp.source) : '']);
      add.push(...movedSpecs.map(typed));
    }
    for (const [s, e, t] of edits.sort((x, y) => y[0] - x[0])) text = text.slice(0, s) + t + text.slice(e);
    writeFileSync(file, mergeImport(text, file, add, relImport(file, to)));
  }
  console.log(`${relative(ROOT, from)} → ${relative(ROOT, to)}: ${[...found].join(', ')}${importers.length ? ` (importers: ${importers.map((f) => relative(ROOT, f)).join(', ')})` : ''}`);
  if (dynamicImporters.length) console.log(`  import()ed from: ${dynamicImporters.join('; ')}: they take these from ${relative(ROOT, to)} now`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const docAt = args.indexOf('--doc');
  const doc = docAt >= 0 ? args.splice(docAt, 2)[1] : undefined;
  const [fromPath, toPath, ...names] = args;
  if (!fromPath || !toPath || !names.length) {
    console.error('usage: node scripts/split-module.ts <from.ts> <to.ts> [--doc "<comment>"] <name|stmt:<prefix>>...');
    process.exit(2);
  }
  splitModule(fromPath, toPath, names, doc);
}
