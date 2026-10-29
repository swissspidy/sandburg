/** Small WebAssembly modules for the growth guard's tests (wasm-grow-guard*.test.ts). */

export const leb = (n: number) => {
  const out: number[] = [];
  do {
    let x = n & 0x7f;
    n >>>= 7;
    if (n) x |= 0x80;
    out.push(x);
  } while (n);
  return out;
};
const section = (id: number, content: number[]) => [id, ...leb(content.length), ...content];

/**
 * A module importing a shared memory (env.memory, 1 to 2 pages) with one function of `params` and
 * no results, exported as `f`: `locals` (raw local declarations, after their count) and `code`
 * (`end` is added, unless `end` is false).
 */
export function moduleWith(code: ArrayLike<number>, { params = [] as number[], locals = [] as number[][], end = true } = {}): Uint8Array<ArrayBuffer> {
  const head = [...leb(locals.length), ...locals.flat()];
  const length = head.length + code.length + (end ? 1 : 0);
  const before = [
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [1, 0x60, ...leb(params.length), ...params, 0]),
    ...section(2, [1, 3, ...Buffer.from('env'), 6, ...Buffer.from('memory'), 0x02, 0x03, 1, 2]),
    ...section(3, [1, 0]),
    ...section(7, [1, 1, 0x66, 0x00, 0]),
  ];
  const sizes = [...leb(1), ...leb(length)];
  const out = new Uint8Array(before.length + 1 + leb(sizes.length + length).length + sizes.length + length);
  let at = 0;
  for (const part of [before, [10], leb(sizes.length + length), sizes, head]) {
    out.set(part, at);
    at += part.length;
  }
  out.set(code, at);
  if (end) out[at + code.length] = 0x0b;
  return out;
}

/** `pattern` `n` times. */
export function repeated(pattern: number[], n: number): Uint8Array {
  const out = new Uint8Array(pattern.length * n);
  for (let i = 0; i < n; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** memory.fill(0, 0, 0). */
export const FILL_ZEROS = [0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00];
