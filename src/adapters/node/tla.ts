/**
 * Top-level await for the node runtime's CommonJS loader (ADR 0006).
 *
 * esbuild cannot convert a module with top-level await to CommonJS. So such a
 * module becomes an "async module", as bundlers do it: its imports and
 * exports stay static, and the rest of its body runs in an async function
 * whose promise is exported as __sandburg_tla. Before its own body, a module
 * awaits the __sandburg_tla of everything it imports, so modules evaluate in
 * import order, each after its dependencies have finished, as in Node.
 *
 *   import { open } from './db.js';           import { open } from './db.js';
 *   export const db = await open();     →     import * as __sandburg_dep_0 from './db.js';
 *   export function q() { … }                 export function q() { … }
 *                                             let db;
 *                                             export { db };
 *                                             const pending = [__sandburg_dep_0.__sandburg_tla].filter(…);
 *                                             export let __sandburg_tla = (async () => {
 *                                               await Promise.all(pending);
 *                                               db = await open();
 *                                             })();
 *
 * Top-level declarations become module-scope `let` bindings assigned in the
 * body (function declarations stay where they are, so hoisting still works);
 * exports of them stay live bindings.
 *
 * Only what is still evaluating is waited for, as in Node: a module without an
 * await of its own whose imports have all finished runs its body at once (its
 * __sandburg_tla is undefined), so a CommonJS package's synchronous require()
 * of it gets it evaluated. An async module's __sandburg_tla becomes undefined
 * once it has finished.
 */
import * as acorn from 'acorn';

type Node = acorn.Node & Record<string, unknown>;

const TLA_EXPORT = '__sandburg_tla';
const PENDING = '__sandburg_pending';
const BODY = '__sandburg_body';

/** Whether an ES module has await (or for await) at its top level. */
export function hasTopLevelAwait(code: string): boolean {
  if (!/\bawait\b/.test(code)) return false;
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node;
    return (ast.body as Node[]).some((stmt) => containsTopLevelAwait(stmt));
  } catch {
    return false;
  }
}

/** Rewrites an ES module (plain JavaScript) into the async-module form above. */
export function toAsyncModule(code: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) as unknown as Node;
  const src = (n: { start: number; end: number }) => code.slice(n.start, n.end);
  const head: string[] = [];
  const body: string[] = [];
  const locals: string[] = [];
  const exported: string[] = [];
  const sources: string[] = [];

  for (const stmt of ast.body as Node[]) {
    switch (stmt.type) {
      case 'ImportDeclaration':
        head.push(src(stmt));
        sources.push((stmt.source as Node).value as string);
        break;
      case 'ExportAllDeclaration':
        head.push(src(stmt));
        sources.push((stmt.source as Node).value as string);
        break;
      case 'ExportNamedDeclaration': {
        const decl = stmt.declaration as Node | null;
        if (!decl) {
          head.push(src(stmt));
          if (stmt.source) sources.push((stmt.source as Node).value as string);
        } else if (decl.type === 'FunctionDeclaration') {
          head.push(src(stmt));
        } else if (decl.type === 'VariableDeclaration') {
          const names = declaredNames(decl);
          locals.push(...names);
          exported.push(...names);
          body.push(assignments(decl, src));
        } else if (decl.type === 'ClassDeclaration') {
          const name = (decl.id as Node).name as string;
          locals.push(name);
          exported.push(name);
          body.push(`${name} = ${src(decl)};`);
        } else head.push(src(stmt));
        break;
      }
      case 'ExportDefaultDeclaration': {
        const decl = stmt.declaration as Node;
        if (decl.type === 'FunctionDeclaration') head.push(src(stmt));
        else {
          const name = decl.type === 'ClassDeclaration' && decl.id ? ((decl.id as Node).name as string) : '__sandburg_default';
          locals.push(name);
          exported.push(`${name} as default`);
          body.push(`${name} = ${decl.type === 'ClassDeclaration' ? src(decl) : `(${src(decl)})`};`);
        }
        break;
      }
      case 'FunctionDeclaration':
        head.push(src(stmt));
        break;
      case 'VariableDeclaration':
        locals.push(...declaredNames(stmt));
        body.push(assignments(stmt, src));
        break;
      case 'ClassDeclaration': {
        const name = (stmt.id as Node).name as string;
        locals.push(name);
        body.push(`${name} = ${src(stmt)};`);
        break;
      }
      default:
        body.push(src(stmt));
    }
  }

  const unique = [...new Set(sources)];
  const deps = unique.map((s, i) => `import * as __sandburg_dep_${i} from ${JSON.stringify(s)};`);
  // The imports still evaluating: an import that finished (or never was an async module) has none.
  const pending = `const ${PENDING} = [${unique.map((_, i) => `__sandburg_dep_${i}.${TLA_EXPORT}`).join(', ')}].filter((p) => p);`;
  const ownAwait = (ast.body as Node[]).some((stmt) => containsTopLevelAwait(stmt));
  const evaluation = ownAwait
    ? `export let ${TLA_EXPORT} = (async () => {\nif (${PENDING}.length) await Promise.all(${PENDING});\n${body.join('\n')}\n})();`
    : // No await of its own: its body runs at once when nothing it imports is still evaluating, as an ES
      // module's does, so a synchronous require() of it (a CommonJS package's) gets it evaluated.
      `function ${BODY}() {\n${body.join('\n')}\n}\nexport let ${TLA_EXPORT} = ${PENDING}.length ? Promise.all(${PENDING}).then(${BODY}) : ${BODY}();`;
  return [
    ...head,
    ...deps,
    locals.length ? `let ${[...new Set(locals)].join(', ')};` : '',
    exported.length ? `export { ${exported.join(', ')} };` : '',
    pending,
    evaluation,
    // Once evaluated, nothing to wait for (a live binding): its importers that come later run at once.
    // A rejection stays, for them to see (and is handled here only so as not to be reported twice).
    `if (${TLA_EXPORT}) ${TLA_EXPORT}.then(() => { ${TLA_EXPORT} = undefined; }, () => {});`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** `const a = 1, { b } = c;` → `a = 1; ({ b } = c);` (declarations without an initializer need nothing). */
function assignments(decl: Node, src: (n: { start: number; end: number }) => string): string {
  return (decl.declarations as Node[])
    .filter((d) => d.init)
    .map((d) => {
      const target = d.id as Node;
      const text = `${src(target)} = ${src(d.init as Node)}`;
      return target.type === 'Identifier' ? `${text};` : `(${text});`;
    })
    .join('\n');
}

function declaredNames(decl: Node): string[] {
  const names: string[] = [];
  const visit = (p: Node | null) => {
    if (!p) return;
    switch (p.type) {
      case 'Identifier':
        names.push(p.name as string);
        break;
      case 'ObjectPattern':
        for (const prop of p.properties as Node[]) visit(prop.type === 'RestElement' ? (prop.argument as Node) : (prop.value as Node));
        break;
      case 'ArrayPattern':
        for (const el of p.elements as (Node | null)[]) visit(el);
        break;
      case 'RestElement':
        visit(p.argument as Node);
        break;
      case 'AssignmentPattern':
        visit(p.left as Node);
        break;
    }
  };
  for (const d of decl.declarations as Node[]) visit(d.id as Node);
  return names;
}

/** An await (or for await) in `node` that is not inside a nested function. */
function containsTopLevelAwait(node: Node): boolean {
  let found = false;
  const walk = (n: unknown) => {
    if (found || !n || typeof n !== 'object') return;
    const node = n as Node;
    if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) {
      found = true;
      return;
    }
    if (/Function/.test(node.type)) return;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') walk(v);
    }
  };
  walk(node);
  return found;
}
