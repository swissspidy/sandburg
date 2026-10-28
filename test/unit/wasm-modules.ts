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
export function moduleWith(code: number[], { params = [] as number[], locals = [] as number[][], end = true } = {}): Uint8Array<ArrayBuffer> {
  const body = [...leb(locals.length), ...locals.flat(), ...code, ...(end ? [0x0b] : [])];
  return new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [1, 0x60, ...leb(params.length), ...params, 0]),
    ...section(2, [1, 3, ...Buffer.from('env'), 6, ...Buffer.from('memory'), 0x02, 0x03, 1, 2]),
    ...section(3, [1, 0]),
    ...section(7, [1, 1, 0x66, 0x00, 0]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
}

/** memory.fill(0, 0, 0). */
export const FILL_ZEROS = [0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00];
