/**
 * ES modules may declare their own `require`, `module`, `exports`, `__dirname`
 * or `__filename` (Vite's CLI does: `const require = createRequire(import.meta.url)`,
 * `const __dirname = …`). In Node's ESM these are not predefined, but the runtime
 * runs converted ES modules inside a CommonJS wrapper, where some of them are, and
 * esbuild's conversion emits `require(…)` for imports.
 *
 * esbuild renames a module's own `require` and `module` where its CommonJS output uses them, and
 * the wrapper of a converted ES module names its file and directory parameters so that no module
 * declares them (ESM_DEFINE sends `import.meta.dirname` and the free `__dirname` there). What can
 * still clash is a declaration esbuild leaves alone (a top-level `let exports`): a converted module
 * that does not parse in its wrapper (collidesWithWrapper) is converted again after
 * renameCommonJsNames. That check is V8's parser (~30 ms for Vite's 1.4 MB node chunk); renaming
 * parsed every such module with acorn (~350 ms for that chunk).
 */
import * as acorn from 'acorn';

// The CommonJS names, and the names a converted ES module's wrapper gives its file, directory and
// import.meta.url (ESM_WRAPPER_PARAMS): a module declaring one would clash with the wrapper too.
const RESERVED = ['require', 'module', 'exports', '__dirname', '__filename', '__sandburg_filename', '__sandburg_dirname', '__sandburg_import_meta_url'];

/** The parameters of a converted ES module's wrapper, as the runtime's loader names them (Module.prototype._compile in loader.ts). */
export const ESM_WRAPPER_PARAMS = ['exports', 'require', 'module', '__sandburg_filename', '__sandburg_dirname', '__sandburg_import_meta_url'];

/** esbuild's define for an ES module converted for that wrapper: import.meta, and `__dirname` and `__filename` where the module does not declare them. */
export const ESM_DEFINE: Record<string, string> = {
  'import.meta.url': '__sandburg_import_meta_url',
  'import.meta.dirname': '__sandburg_dirname',
  'import.meta.filename': '__sandburg_filename',
  __dirname: '__sandburg_dirname',
  __filename: '__sandburg_filename',
};

/**
 * Whether converted code would not parse in its wrapper: it declares one of the wrapper's
 * parameters where esbuild did not rename it. Only a lexical declaration (let, const, class) of a
 * parameter's name clashes with it (var and function may redeclare one), and only in the converted
 * code (esbuild renames what it uses itself, and imports become vars), so only code that has one is
 * parsed (V8's parser, never run): the source's `function (module, exports)` and `import`s sent ~15%
 * of an Astro install's ES modules to the parser before, for one that clashed.
 */
export function collidesWithWrapper(code: string): boolean {
  if (!LEXICAL.test(code)) return false;
  try {
    new Function(...ESM_WRAPPER_PARAMS, code);
    return false;
  } catch (e) {
    return e instanceof SyntaxError;
  }
}
const PARAMS = ESM_WRAPPER_PARAMS.join('|');
// A name as the first one declared, or after a `,`, `{` or `:` later in the declaration
// (`const a = 1, require = 2`, `const { a = 1, module } = x`): the first stops at `=` so that
// `const x = require(...)` is not parsed. DECLARES likewise.
const LEXICAL = new RegExp(`\\b(?:const|let|class)\\s*\\{?[^;=]*?\\b(?:${PARAMS})\\b|\\b(?:const|let)\\b[^;]*?[,{:]\\s*(?:${PARAMS})\\s*(?:[=,};]|$)`);
const DECLARES = new RegExp(`\\b(?:const|let|var|function|class|as|import)\\s*\\{?[^;=]*?\\b(?:${RESERVED.join('|')})\\b|\\b(?:const|let|var)\\b[^;]*?[,{:]\\s*(?:${RESERVED.join('|')})\\s*(?:[=,};]|$)`);

type Node = acorn.Node & Record<string, unknown>;

/** Renames module-declared `require`/`module`/`exports`/`__dirname`/`__filename` (and the wrapper's own names, RESERVED) to `__sandburg_esm_<name>`. */
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
  // In one pass: splicing each edit into the whole string copied it once per edit (480 edits in
  // Vite's 1.4 MB node chunk, 1.2 s of the host's start-up).
  edits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const e of edits) {
    parts.push(code.slice(at, e.start), e.text);
    at = e.end;
  }
  parts.push(code.slice(at));
  return parts.join('');
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
