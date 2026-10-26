/**
 * The await rewrite (src/node-runtime/await-context.ts) done from acorn's AST: what the token scan
 * must produce, exactly. Test-only: acorn is ~10x slower than the scan.
 */
import * as acorn from 'acorn';
import { AWAIT_CONTEXT_GLOBAL as G } from '../../src/node-runtime/names.ts';

type Node = acorn.Node & Record<string, unknown>;
const L = '__sbac';
const BODY_START = `const ${L} = ${G}.e(); try { `;
const BODY_END = ` } finally { ${G}.x(${L}); }`;

export function oracleRewrite(code: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, preserveParens: true }) as unknown as Node;
  const edits: [number, number, string][] = [];
  const visit = (node: Node, fn: { node: Node; awaits: Node[]; resumes: number[] } | null): void => {
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
    if (isFn) {
      const own = { node, awaits: [] as Node[], resumes: [] as number[] };
      for (const p of node.params as Node[]) visit(p, own);
      visit(node.body as Node, own);
      if (node.async && own.awaits.length) {
        const body = node.body as Node;
        if (body.type === 'BlockStatement') {
          let at = body.start + 1;
          for (const s of body.body as Node[]) {
            if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') at = s.end;
            else break;
          }
          edits.push([at, 3, BODY_START], [body.end - 1, 1, BODY_END]);
        } else edits.push([body.start, 4, `{ ${BODY_START}return `], [body.end, 2, `;${BODY_END} }`]);
        for (const a of own.awaits) edits.push([a.start, 6, `${G}.r(${L}, `], [a.start + 5, 7, ` ${G}.s(${L},`], [a.end, 0, '))']);
        for (const r of own.resumes) edits.push([r, 5, `${G}.k(${L});`]);
      }
      return;
    }
    if (node.type === 'AwaitExpression' && fn) fn.awaits.push(node);
    if (node.type === 'TryStatement' && fn) {
      const handler = node.handler as Node | null;
      if (handler) fn.resumes.push((handler.body as Node).start + 1);
      const finalizer = node.finalizer as Node | null;
      if (finalizer) fn.resumes.push(finalizer.start + 1);
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c as Node, fn);
      }
      else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') visit(v as Node, fn);
    }
  };
  visit(ast, null);
  if (!edits.length) return code;
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = '';
  let at = 0;
  for (const [pos, , text] of edits) {
    out += code.slice(at, pos) + text;
    at = pos;
  }
  return out + code.slice(at);
}
