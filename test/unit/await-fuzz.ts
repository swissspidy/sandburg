/**
 * Random async programs for the await scan's differential tests (await-context.test.ts): esbuild's
 * output of them is rewritten by the scan and by the AST (await-oracle.ts), which must agree.
 */
export function programs(seed: number): () => string {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const NAMES = ['a', 'b', 'get', 'set', 'static', 'async', 'x', 'of', 'let', 'yield'];
  const KEYS = ['a', 'get', 'set', 'static', 'async', 'if', 'catch', 'finally', 'await', 'of', 'new', 'typeof', 'return', 'default', 'case', "'s'", '1', '[k]', 'then', 'do', 'else', 'in', 'class', 'function', 'with', 'yield', 'let'];
  let depth = 0;
  const deeper = <T>(f: () => T, fallback: () => T): T => {
    if (depth > 3) return fallback();
    depth++;
    try {
      return f();
    } finally {
      depth--;
    }
  };
  const block = (inAsync: boolean): string => `{ ${stmt(inAsync)} ${rnd() < 0.5 ? stmt(inAsync) : ''} }`;
  const params = () => pick(['', 'p', 'p = 1', '{ p }', 'p, ...q']);
  const member = (inAsync: boolean): string =>
    deeper(
      () =>
        pick([
          () => `${pick(KEYS)} = ${expr(false)};`,
          () => `${pick(['', 'static ', 'async ', 'get ', 'static async '])}${pick(KEYS)}(${params()}) ${block(true)}`,
          () => `${pick(KEYS)};`,
        ])(),
      () => 'm;',
    ) + (inAsync ? '' : '');
  const objMember = (): string => pick([() => `${pick(KEYS)}: ${expr(false)}`, () => `${pick(['', 'async ', 'get '])}${pick(KEYS)}(${params()}) ${block(true)}`, () => `...${unary(false)}`, () => pick(NAMES)])();
  const prim = (inAsync: boolean): string =>
    deeper(
      () =>
        pick([
          () => pick([...NAMES, '/r[/]e/g', '`t`', '.5', '0x1n', '"s/"', 'this', 'null']),
          () => `\`a\${${expr(inAsync)}}b\``,
          () => `(${expr(inAsync)})`,
          () => `[${expr(inAsync)}, ${expr(inAsync)}]`,
          () => `{ ${objMember()}, ${objMember()} }`,
          () => `${pick(['async ', ''])}(${params()}) => ${rnd() < 0.5 ? block(true) : expr(true)}`,
          () => `async ${pick(['p', 'x'])} => ${expr(true)}`,
          () => `${pick(['async ', ''])}function ${pick(['', 'g'])}(${params()}) ${block(true)}`,
          () => `class ${pick(['', 'K'])}${pick(['', ' extends B', ' extends (class {})', ' extends f(class { m() {} })'])} { ${member(inAsync)} ${member(inAsync)} }`,
        ])(),
      () => pick(NAMES),
    );
  const unary = (inAsync: boolean): string => {
    let e = prim(inAsync);
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) e += pick(['.p', '?.p', '[0]', '`t`', '?.[0]', '?.(x)', '.of', '(1)']);
    if (rnd() < 0.15) e += pick(['++', '--']);
    if (rnd() < 0.2) e = pick(['!', '-', 'typeof ', 'void ']) + e;
    if (inAsync && rnd() < 0.5) e = `await ${e}`;
    return e;
  };
  const expr = (inAsync: boolean): string =>
    deeper(
      () =>
        pick([
          () => unary(inAsync),
          () => `${unary(inAsync)} ${pick(['+', '/', '*', '??', '&&', 'in', 'instanceof', '===', '<', '='])} ${unary(inAsync)}`,
          () => `${unary(inAsync)} ? ${expr(inAsync)} : ${expr(inAsync)}`,
          () => `${pick(NAMES)} / ${unary(inAsync)} / 2`,
          () => `${unary(inAsync)}, ${unary(inAsync)}`,
          () => `new a(${expr(inAsync)})`,
          () => `x ${pick(['+=', '||=', '??='])} ${unary(inAsync)}`,
        ])(),
      () => unary(inAsync),
    );
  const stmt = (inAsync: boolean): string =>
    deeper(
      () =>
        pick([
          () => `${expr(inAsync)};`,
          () => `const v = ${expr(inAsync)};`,
          () => `const { v = ${expr(inAsync)} } = ${expr(inAsync)};`,
          () => `if (${expr(inAsync)}) ${block(inAsync)} else ${block(inAsync)}`,
          () => `try ${block(inAsync)} catch (${pick(['e', '{ m = ' + expr(inAsync) + ' }', '{ message }', '[m]'])}) ${block(inAsync)} finally ${block(inAsync)}`,
          () => `L: for (const i of ${expr(inAsync)}) { ${stmt(inAsync)} continue L; }`,
          () => `switch (${expr(inAsync)}) { case 1: ${stmt(inAsync)} default: { ${stmt(inAsync)} } }`,
          () => `return ${expr(inAsync)};`,
          () => `${pick(['async ', ''])}function g(${params()}) ${block(true)}`,
          () => `class D extends ${pick(['B', '(B)', 'f(B)', 'f(class { async m() { await x; } })', 'function () { return async () => { await x; }; }', 'async function () { await a; }', 'class extends B {}'])} { ${member(inAsync)} }`,
          () => `for (; ${expr(inAsync)}; ) ${block(inAsync)}`,
          () => `while (${expr(inAsync)}) ${block(inAsync)}`,
          () => `var of = 1, get = 2;`,
          () => `for (let i = 0; i < 2; i++) ${block(inAsync)}`,
          () => `for (const k in ${expr(inAsync)}) ${block(inAsync)}`,
          () => `M: { ${stmt(inAsync)} break M; }`,
          () => `throw ${expr(inAsync)};`,
        ])(),
      () => 'x;',
    );
  return () => `async function f() { ${stmt(true)} ${stmt(true)} }`;
}
