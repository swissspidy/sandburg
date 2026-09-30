/**
 * ES modules may declare their own `require`, `module`, `exports`, `__dirname`
 * or `__filename` (Vite's CLI does: `const require = createRequire(import.meta.url)`,
 * `const __dirname = …`). In Node's ESM these are not predefined, but the runtime
 * runs converted ES modules inside a CommonJS wrapper, where they are, and
 * esbuild's conversion emits `require(…)` for imports. So such bindings are
 * renamed throughout the module first. Renaming every occurrence is safe: in an
 * ES module these names can only refer to the module's own bindings.
 */
import * as acorn from 'acorn';

const RESERVED = ['require', 'module', 'exports', '__dirname', '__filename'];
const DECLARES = new RegExp(`\\b(?:const|let|var|function|class|as|import)\\s*\\{?[^;=]*?\\b(?:${RESERVED.join('|')})\\b`);

type Node = acorn.Node & Record<string, unknown>;

/** Renames module-declared `require`/`module`/`exports`/`__dirname`/`__filename` to `__sandburg_esm_<name>`. */
export function renameCommonJsNames(code: string): string {
  if (!DECLARES.test(code)) return code;
  let ast: Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) as unknown as Node;
  } catch {
    return code;
  }
  const declared = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  const collect = (p: Node | null) => {
    if (!p) return;
    if (p.type === 'Identifier' && RESERVED.includes(p.name as string)) declared.add(p.name as string);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as Node[]) collect((prop.type === 'RestElement' ? prop.argument : prop.value) as Node);
    else if (p.type === 'ArrayPattern') for (const el of p.elements as (Node | null)[]) collect(el);
    else if (p.type === 'RestElement') collect(p.argument as Node);
    else if (p.type === 'AssignmentPattern') collect(p.left as Node);
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') collect(node.id as Node);
    else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassExpression') && node.id) collect(node.id as Node);
    else if (/Function/.test(node.type as string)) for (const p of node.params as Node[]) collect(p);
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') collect(node.local as Node);
    else if (node.type === 'CatchClause') collect(node.param as Node);
  });
  if (!declared.size) return code;

  const rename = (name: string) => `__sandburg_esm_${name}`;
  walk(ast, (node, parent, key) => {
    if (node.type !== 'Identifier' || !declared.has(node.name as string)) return;
    // Not a variable reference: property names, member properties, labels, export aliases, import/export names.
    if (parent) {
      if ((parent.type === 'MemberExpression' || parent.type === 'MetaProperty') && key === 'property' && !parent.computed) return;
      if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) {
        if (parent.type === 'Property' && parent.shorthand) {
          // { require } → { require: __sandburg_esm_require } (or the pattern form)
          edits.push({ start: node.end, end: node.end, text: `: ${rename(node.name as string)}` });
        }
        return;
      }
      if (parent.type === 'Property' && parent.shorthand && key === 'value') return; // handled with the key
      if (parent.type === 'ImportSpecifier' && key === 'imported') return;
      if (parent.type === 'ExportSpecifier' && key === 'exported') return;
      if (parent.type === 'ExportSpecifier' && key === 'local' && (parent.local as Node).start === (parent.exported as Node).start) {
        edits.push({ start: node.start, end: node.end, text: `${rename(node.name as string)} as ${node.name as string}` });
        return;
      }
      if (parent.type === 'ImportSpecifier' && key === 'local' && (parent.local as Node).start === (parent.imported as Node).start) {
        edits.push({ start: node.start, end: node.end, text: `${node.name as string} as ${rename(node.name as string)}` });
        return;
      }
      if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label') return;
    }
    edits.push({ start: node.start, end: node.end, text: rename(node.name as string) });
  });
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function walk(node: Node, visit: (node: Node, parent: Node | null, key: string | null) => void, parent: Node | null = null, key: string | null = null): void {
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const child of v) if (child && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, visit, node, k);
    } else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') walk(v as Node, visit, node, k);
  }
}
