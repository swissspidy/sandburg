/**
 * Makes WebAssembly modules with shared memory safe from V8's lazy memory growth (ADR 0067).
 *
 * When one thread grows a shared memory, V8 updates the memory's size in the other threads'
 * instances only when each handles an interrupt, at its next stack check. Plain loads and stores
 * are checked by guard pages and see the new memory at once, but bulk memory operations
 * (memory.fill, memory.copy), atomic operations and memory.size use the instance's size. So a
 * thread that learns of the new memory through shared memory (dlmalloc handing it a chunk another
 * thread's sbrk added) and calls memory.fill on it there traps with "memory access out of bounds",
 * although the access is in bounds. Node 24 and Chromium both do this; rolldown's WebAssembly
 * build trapped in calloc on its main thread.
 *
 * The rewrite puts a check before each such operation: when it reaches past the size the instance
 * knows (memory.size), `memory.grow 0` makes V8 update the instance first. An access that is out of
 * bounds still traps. Function, type and other indices are unchanged; only function bodies (and
 * their locals) are.
 */

const SHARED = 0x02;
const MEMORY64 = 0x04;

/** Reads unsigned and signed LEB128 numbers and raw bytes from a module. */
class Reader {
  readonly b: Uint8Array;
  p: number;
  constructor(b: Uint8Array, p = 0) {
    this.b = b;
    this.p = p;
  }
  u32(): number {
    let r = 0;
    let s = 0;
    for (;;) {
      const x = this.b[this.p++];
      if (x === undefined) throw new Error('truncated');
      r += (x & 0x7f) * 2 ** s;
      if (!(x & 0x80)) return r;
      s += 7;
    }
  }
  /** Skips a LEB128 number (signed or unsigned). */
  skip(): void {
    while (this.b[this.p++]! & 0x80) if (this.p > this.b.length) throw new Error('truncated');
  }
  byte(): number {
    const x = this.b[this.p++];
    if (x === undefined) throw new Error('truncated');
    return x;
  }
}

/** Grows a byte buffer. */
class Writer {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  private room(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  bytes(b: ArrayLike<number>): void {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  u32(n: number): void {
    this.room(5);
    do {
      let x = n % 128;
      n = Math.floor(n / 128);
      if (n) x |= 0x80;
      this.buf[this.length++] = x;
    } while (n);
  }
  /** A signed LEB128 number (for i64.const of up to 2^53). */
  s64(n: number): void {
    this.room(10);
    for (;;) {
      const x = n & 0x7f;
      n = Math.floor(n / 128);
      if ((n === 0 && !(x & 0x40)) || (n === -1 && x & 0x40)) {
        this.buf[this.length++] = x;
        return;
      }
      this.buf[this.length++] = x | 0x80;
    }
  }
  done(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

/**
 * The module's memory, when it is the only one and shared: its import or definition flags. null
 * otherwise (no shared memory, several memories, or a memory64 one: left as they are).
 */
function sharedMemoryFlags(bytes: Uint8Array): number | null {
  const r = new Reader(bytes, 8);
  const memories: number[] = [];
  while (r.p < bytes.length) {
    const id = r.byte();
    const size = r.u32();
    const end = r.p + size;
    if (id === 2) {
      for (let n = r.u32(); n > 0; n--) {
        // module and field names (`r.p += r.u32()` would add to the position before the length)
        for (let name = 0; name < 2; name++) {
          const length = r.u32();
          r.p += length;
        }
        const kind = r.byte();
        if (kind === 0x00) r.skip();
        else if (kind === 0x01) {
          r.byte();
          const flags = r.byte();
          r.skip();
          if (flags & 1) r.skip();
        } else if (kind === 0x02) {
          const flags = r.byte();
          memories.push(flags);
          r.skip();
          if (flags & 1) r.skip();
        } else if (kind === 0x03) {
          // a global: its value type (a byte for numbers and references) and mutability
          if (r.byte() >= 0x63 && r.b[r.p - 1]! <= 0x64) return null;
          r.byte();
        } else if (kind === 0x04) {
          r.byte();
          r.skip();
        } else return null;
      }
    } else if (id === 5) {
      for (let n = r.u32(); n > 0; n--) {
        const flags = r.byte();
        memories.push(flags);
        r.skip();
        if (flags & 1) r.skip();
      }
    }
    if (id === 10) break;
    r.p = end;
  }
  if (memories.length !== 1 || !(memories[0]! & SHARED) || memories[0]! & MEMORY64) return null;
  return memories[0]!;
}

// Value types of the temporaries a guarded function gets (after its own locals).
const I32 = 0x7f;
const I64 = 0x7e;
/** The temporaries: an address, two i32 operands, two i64 operands. */
const TEMPS = [I32, I32, I32, I64, I64] as const;
const [A, B, C, X, Y] = [0, 1, 2, 3, 4];

/**
 * The operands of each atomic operation (0xFE prefix) after its address, and the bytes it accesses.
 * Order of the read-modify-write groups: i32, i64, i32 8u, i32 16u, i64 8u, i64 16u, i64 32u.
 */
function atomicShape(op: number): { width: number; operands: number[] } | null {
  if (op === 0x00) return { width: 4, operands: [I32] };
  if (op === 0x01) return { width: 4, operands: [I32, I64] };
  if (op === 0x02) return { width: 8, operands: [I64, I64] };
  const loads: Record<number, [number, number]> = { 0x10: [4, I32], 0x11: [8, I64], 0x12: [1, I32], 0x13: [2, I32], 0x14: [1, I64], 0x15: [2, I64], 0x16: [4, I64] };
  if (loads[op]) return { width: loads[op][0], operands: [] };
  if (op >= 0x17 && op <= 0x1d) {
    const [width, type] = ([[4, I32], [8, I64], [1, I32], [2, I32], [1, I64], [2, I64], [4, I64]] as const)[op - 0x17]!;
    return { width, operands: [type] };
  }
  if (op >= 0x1e && op <= 0x4e) {
    const [width, type] = ([[4, I32], [8, I64], [1, I32], [2, I32], [1, I64], [2, I64], [4, I64]] as const)[(op - 0x1e) % 7]!;
    return { width, operands: op >= 0x48 ? [type, type] : [type] };
  }
  return null;
}

/** Thrown for an instruction the rewrite does not know: the module is left as it is. */
class Unknown extends Error {}

/** Skips a block type (empty, a value type, or a type index) or a heap type. */
function blockType(r: Reader): void {
  const x = r.b[r.p]!;
  if (x === 0x63 || x === 0x64) throw new Unknown('typed reference block');
  r.skip();
}

/** Reads a memory argument (alignment, offset): the offset. */
function memarg(r: Reader): number {
  const align = r.u32();
  if (align & 0x40) throw new Unknown('multiple memories');
  return r.u32();
}

/** Skips the immediates of an instruction without a prefix (`op` has been read). */
function skipImmediates(r: Reader, op: number): void {
  if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x19 || op === 0x1a || op === 0x1b || op === 0x0a || op === 0xd1 || op === 0xd3 || op === 0xd5) return;
  if (op >= 0x45 && op <= 0xc4) return;
  if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x06) return blockType(r);
  if (op === 0x07 || op === 0x08 || op === 0x09 || op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || op === 0x14 || op === 0x15 || op === 0x18 || op === 0xd2 || op === 0xd4 || op === 0xd6) return r.skip();
  if (op >= 0x20 && op <= 0x26) return r.skip();
  if (op === 0x11 || op === 0x13) {
    r.skip();
    r.skip();
    return;
  }
  if (op === 0x0e) {
    for (let n = r.u32(); n >= 0; n--) r.skip();
    return;
  }
  if (op === 0x1c) {
    for (let n = r.u32(); n > 0; n--) if (r.byte() >= 0x63 && r.b[r.p - 1]! <= 0x64) throw new Unknown('typed select');
    return;
  }
  if (op === 0x1f) {
    blockType(r);
    for (let n = r.u32(); n > 0; n--) {
      const kind = r.byte();
      if (kind <= 1) r.skip();
      r.skip();
    }
    return;
  }
  if (op >= 0x28 && op <= 0x3e) {
    memarg(r);
    return;
  }
  if (op === 0x3f || op === 0x40) return r.skip();
  if (op === 0x41 || op === 0x42) return r.skip();
  if (op === 0x43) {
    r.p += 4;
    return;
  }
  if (op === 0x44) {
    r.p += 8;
    return;
  }
  if (op === 0xd0) {
    blockType(r);
    return;
  }
  throw new Unknown(`opcode 0x${op.toString(16)}`);
}

/** Skips the immediates of a 0xFC or 0xFD instruction (its prefix and opcode have been read). */
function skipPrefixed(r: Reader, prefix: number, sub: number): void {
  if (prefix === 0xfc) {
    if (sub <= 7) return;
    if (sub === 8 || sub === 12 || sub === 14) {
      r.skip();
      r.skip();
      return;
    }
    if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) return r.skip();
    throw new Unknown(`0xfc ${sub}`);
  }
  if (prefix === 0xfd) {
    if (sub <= 11 || sub === 92 || sub === 93) {
      memarg(r);
      return;
    }
    if (sub === 12 || sub === 13) {
      r.p += 16;
      return;
    }
    if (sub >= 21 && sub <= 34) {
      r.p += 1;
      return;
    }
    if (sub >= 84 && sub <= 91) {
      memarg(r);
      r.p += 1;
      return;
    }
    return;
  }
  throw new Unknown(`prefix 0x${prefix.toString(16)}`);
}

/**
 * Emits the check for an access of [address, address + length) where the address is in local
 * `addr` and the length is a constant or in local `len`: when it ends past what memory.size gives,
 * `memory.grow 0`, which updates the instance's size.
 */
function check(w: Writer, addr: number, length: { constant: number } | { local: number }): void {
  w.bytes([0x20]);
  w.u32(addr);
  w.bytes([0xad]); // i64.extend_i32_u
  if ('constant' in length) {
    w.bytes([0x42]);
    w.s64(length.constant);
  } else {
    w.bytes([0x20]);
    w.u32(length.local);
    w.bytes([0xad]);
  }
  // i64.add, memory.size, i64.extend_i32_u, i64.const 16, i64.shl, i64.gt_u, if, i32.const 0, memory.grow, drop, end
  w.bytes([0x7c, 0x3f, 0x00, 0xad, 0x42, 0x10, 0x86, 0x56, 0x04, 0x40, 0x41, 0x00, 0x40, 0x00, 0x1a, 0x0b]);
}

const set = (w: Writer, local: number) => (w.bytes([0x21]), w.u32(local));
const get = (w: Writer, local: number) => (w.bytes([0x20]), w.u32(local));

/**
 * One function body, guarded; null when it has no operation to guard. `params`: how many
 * parameters the function has (its temporaries come after them and its locals).
 */
function guardBody(body: Uint8Array, params: number): Uint8Array | null {
  const r = new Reader(body);
  let locals = 0;
  const groups = r.u32();
  for (let i = 0; i < groups; i++) {
    locals += r.u32();
    if (r.byte() >= 0x63 && r.b[r.p - 1]! <= 0x64) r.skip();
  }
  const codeStart = r.p;
  const base = params + locals;
  let w: Writer | null = null;
  let copied = codeStart;
  const out = () => {
    if (!w) {
      w = new Writer();
      // The function's own local groups, then the temporaries: its locals keep their indices.
      w.u32(groups + TEMPS.length);
      w.bytes(body.subarray(lebLength(body, 0), codeStart));
      for (const t of TEMPS) w.bytes([0x01, t]);
    }
    return w;
  };
  while (r.p < body.length) {
    const at = r.p;
    const op = r.byte();
    if (op !== 0xfc && op !== 0xfd && op !== 0xfe) {
      skipImmediates(r, op);
      continue;
    }
    const sub = r.u32();
    if (op === 0xfc && (sub === 10 || sub === 11)) {
      r.skip();
      if (sub === 10) r.skip();
      const o = out();
      o.bytes(body.subarray(copied, at));
      if (sub === 11) {
        // memory.fill: [dst, value, length]
        set(o, base + C);
        set(o, base + B);
        set(o, base + A);
        check(o, base + A, { local: base + C });
        get(o, base + A);
        get(o, base + B);
        get(o, base + C);
      } else {
        // memory.copy: [dst, src, length]
        set(o, base + C);
        set(o, base + B);
        set(o, base + A);
        check(o, base + A, { local: base + C });
        check(o, base + B, { local: base + C });
        get(o, base + A);
        get(o, base + B);
        get(o, base + C);
      }
      o.bytes(body.subarray(at, r.p));
      copied = r.p;
      continue;
    }
    if (op === 0xfe) {
      if (sub === 0x03) {
        r.p += 1;
        continue;
      }
      const shape = atomicShape(sub);
      if (!shape) throw new Unknown(`atomic 0x${sub.toString(16)}`);
      const offset = memarg(r);
      const o = out();
      o.bytes(body.subarray(copied, at));
      // The operands above the address, last first, into the temporaries of their types.
      const slots: number[] = [];
      const free = { [I32]: [B, C], [I64]: [X, Y] } as Record<number, number[]>;
      for (const t of shape.operands) slots.push(base + free[t]!.shift()!);
      for (let i = slots.length - 1; i >= 0; i--) set(o, slots[i]!);
      set(o, base + A);
      check(o, base + A, { constant: offset + shape.width });
      get(o, base + A);
      for (const s of slots) get(o, s);
      o.bytes(body.subarray(at, r.p));
      copied = r.p;
      continue;
    }
    skipPrefixed(r, op, sub);
  }
  if (!w) return null;
  const o = w as Writer;
  o.bytes(body.subarray(copied));
  return o.done();
}

function lebLength(b: Uint8Array, p: number): number {
  let n = 1;
  while (b[p++]! & 0x80) n++;
  return n;
}

/** Parameter counts of the module's function types (type section), and the type of each defined function. */
function signatures(bytes: Uint8Array): { params: number[]; funcTypes: number[] } {
  const r = new Reader(bytes, 8);
  const params: number[] = [];
  const funcTypes: number[] = [];
  while (r.p < bytes.length) {
    const id = r.byte();
    const size = r.u32();
    const end = r.p + size;
    if (id === 1) {
      for (let n = r.u32(); n > 0; n--) {
        if (r.byte() !== 0x60) throw new Unknown('type that is not a function');
        const count = r.u32();
        for (let i = 0; i < count; i++) if (r.byte() >= 0x63 && r.b[r.p - 1]! <= 0x64) r.skip();
        params.push(count);
        for (let i = r.u32(); i > 0; i--) if (r.byte() >= 0x63 && r.b[r.p - 1]! <= 0x64) r.skip();
      }
    } else if (id === 3) {
      for (let n = r.u32(); n > 0; n--) funcTypes.push(r.u32());
    }
    r.p = end;
  }
  return { params, funcTypes };
}

/**
 * The module with each bulk memory and atomic operation guarded, when it has a single shared
 * memory; null when it is left as it is (no shared memory, or something the rewrite does not know).
 */
export function guardSharedMemoryGrowth(input: Uint8Array): Uint8Array | null {
  if (input.length < 8 || input[0] !== 0x00 || input[1] !== 0x61 || input[2] !== 0x73 || input[3] !== 0x6d || input[4] !== 1) return null;
  try {
    if (sharedMemoryFlags(input) === null) return null;
    const { params, funcTypes } = signatures(input);
    const w = new Writer();
    w.bytes(input.subarray(0, 8));
    const r = new Reader(input, 8);
    let changed = false;
    while (r.p < input.length) {
      const start = r.p;
      const id = r.byte();
      const size = r.u32();
      const end = r.p + size;
      if (id !== 10) {
        w.bytes(input.subarray(start, end));
        r.p = end;
        continue;
      }
      const code = new Writer();
      const count = r.u32();
      code.u32(count);
      for (let i = 0; i < count; i++) {
        const length = r.u32();
        const body = input.subarray(r.p, r.p + length);
        r.p += length;
        const guarded = guardBody(body, params[funcTypes[i]!]!);
        const chosen = guarded ?? body;
        if (guarded) changed = true;
        code.u32(chosen.length);
        code.bytes(chosen);
      }
      const section = code.done();
      w.bytes([10]);
      w.u32(section.length);
      w.bytes(section);
      r.p = end;
    }
    return changed ? w.done() : null;
  } catch {
    // Something the rewrite does not know (an instruction, a section), or bytes that are not a valid
    // module (WebAssembly reports that itself): the module is compiled as it is.
    return null;
  }
}

const bytesOf = (source: unknown): Uint8Array | null =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : source instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && source instanceof SharedArrayBuffer)
      ? new Uint8Array(source)
      : null;

/** The bytes to compile for `source`: guarded when it is a module with shared memory. */
function guarded<T>(source: T): T | Uint8Array {
  const bytes = bytesOf(source);
  return (bytes && guardSharedMemoryGrowth(bytes)) ?? source;
}

let installed = false;

/**
 * Compiles modules with shared memory guarded (guardSharedMemoryGrowth): `new WebAssembly.Module`,
 * `WebAssembly.compile` and `WebAssembly.instantiate` from bytes. A compiled module passed on to
 * another thread is already guarded. The streaming forms compile as they are.
 */
export function installWasmGrowGuard(): void {
  if (installed) return;
  installed = true;
  const wasm = WebAssembly as unknown as Record<string, unknown>;
  const NativeModule = WebAssembly.Module;
  const nativeCompile = WebAssembly.compile.bind(WebAssembly);
  const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly) as (source: unknown, ...rest: unknown[]) => Promise<unknown>;
  // A function rather than a subclass, so that modules made elsewhere (another thread's) are still
  // `instanceof WebAssembly.Module`; its statics (exports, imports, customSections) are inherited.
  const Module = function Module(this: unknown, source: BufferSource) {
    if (!new.target) throw new TypeError("Class constructor Module cannot be invoked without 'new'");
    return Reflect.construct(NativeModule, [guarded(source)], new.target) as WebAssembly.Module;
  } as unknown as typeof WebAssembly.Module;
  Object.setPrototypeOf(Module, NativeModule);
  Object.defineProperty(Module, 'prototype', { value: NativeModule.prototype, writable: false });
  Object.defineProperty(wasm, 'Module', { value: Module, writable: true, configurable: true, enumerable: false });
  wasm.compile = function compile(source: BufferSource, ...rest: unknown[]) {
    return (nativeCompile as (s: unknown, ...r: unknown[]) => Promise<WebAssembly.Module>)(guarded(source), ...rest);
  };
  wasm.instantiate = function instantiate(source: unknown, ...rest: unknown[]) {
    return nativeInstantiate(source instanceof NativeModule ? source : guarded(source), ...rest);
  };
}
