/**
 * The await rewrite (src/node-runtime/await-context.ts) done from acorn's AST: what the token scan
 * must produce, exactly, and null where it must leave the code to the lowering. Test-only: acorn is
 * ~10x slower than the scan.
 */
import * as acorn from 'acorn';
import { AWAIT_CONTEXT_GLOBAL as G } from '../../src/node-runtime/names.ts';

type Node = acorn.Node & Record<string, unknown>;
const L = '__sbac';
const BODY_START = `const ${L} = ${G}.e(); try { `;
const BODY_END = ` } finally { ${G}.x(${L}); }`;

interface Own {
  node: Node;
  awaits: Node[];
  resumes: number[];
  /** For-of block bodies of this function, and whether one of its awaits is in each. */
  loops: { body: Node; awaits: boolean }[];
  /** A catch parameter with a pattern. */
  unsafe: boolean;
  /** For-of loops with a body not in braces: where their `of` ends and their iterable. */
  bare: { ofEnd: number; right: Node }[];
}

export function oracleRewrite(code: string): string | null {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, preserveParens: true }) as unknown as Node;
  const edits: [number, number, string][] = [];
  let refused = false;
  const visit = (node: Node, fn: Own | null, loops: Own['loops'][number][]): void => {
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
    if (isFn) {
      const own: Own = { node, awaits: [], resumes: [], loops: [], unsafe: false, bare: [] };
      for (const p of node.params as Node[]) visit(p, own, []);
      visit(node.body as Node, own, []);
      if (node.async && own.awaits.length) {
        if (own.unsafe) refused = true;
        const body = node.body as Node;
        if (body.type === 'BlockStatement') {
          let at = body.start + 1;
          for (const s of body.body as Node[]) {
            if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') at = s.end;
            else break;
          }
          edits.push([at, 5, BODY_START], [body.end - 1, 3, BODY_END]);
        } else edits.push([body.start, 6, `{ ${BODY_START}return `], [body.end, 4, `;${BODY_END} }`]);
        for (const a of own.awaits) edits.push([a.start, 10, `${G}.r(${L}, `], [a.start + 5, 11, ` ${G}.s(${L},`], [a.end, 0, '))']);
        for (const r of own.resumes) edits.push([r, 7, `${G}.k(${L});`]);
        for (const l of own.loops) if (l.awaits) edits.push([l.body.start + 1, 8, 'try { '], [l.body.end - 1, 2, ` } catch (__sbe) { ${G}.k(${L}); throw __sbe; }`]);
        for (const b of own.bare) edits.push([b.ofEnd, 9, ` ${G}.i(${L},`], [b.right.end, 1, ')']);
      }
      return;
    }
    if (node.type === 'AwaitExpression' && fn) {
      fn.awaits.push(node);
      for (const l of loops) l.awaits = true;
    }
    if (node.type === 'TryStatement' && fn) {
      const handler = node.handler as Node | null;
      if (handler) {
        fn.resumes.push((handler.body as Node).start + 1);
        const param = handler.param as Node | null;
        if (param && param.type !== 'Identifier') fn.unsafe = true;
      }
      const finalizer = node.finalizer as Node | null;
      if (finalizer) fn.resumes.push(finalizer.start + 1);
    }
    if (node.type === 'ForOfStatement' && fn && !node.await) {
      const body = node.body as Node;
      for (const key of ['left', 'right'] as const) visit(node[key] as Node, fn, loops);
      if (body.type === 'BlockStatement') {
        const loop = { body, awaits: false };
        fn.loops.push(loop);
        visit(body, fn, [...loops, loop]);
      } else {
        fn.bare.push({ ofEnd: code.indexOf('of', (node.left as Node).end) + 2, right: node.right as Node });
        visit(body, fn, loops);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c as Node, fn, loops);
      } else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') visit(v as Node, fn, loops);
    }
  };
  visit(ast, null, []);
  if (refused) return null;
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
