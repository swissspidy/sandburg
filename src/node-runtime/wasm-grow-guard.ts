/**
 * Makes WebAssembly modules with shared memory safe from V8's lazy memory growth (ADR 0070).
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
/**
 * Modules over this are compiled as they are: the rewrite takes ~13 ms a MB of real code, and a
 * module of more than this is not one a dev tool ships.
 */
const MAX_INPUT = 128 << 20;
/**
 * Nor is a module the guard would grow by more than half, and 64 KB (real ones grow by 5-8 %; a
 * small one may grow more): a dense run of atomics, valid or not, is not worth the time and memory.
 */
const MAX_GROWTH = 0.5;
const GROWTH_ALLOWANCE = 64 << 10;

/** The value types `(ref null ht)` and `(ref ht)` (typed function references, GC): the rewrite leaves modules with them as they are. */
const typedReference = (x: number) => x === 0x63 || x === 0x64;

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
    for (;;) {
      const x = this.b[this.p++];
      if (x === undefined) throw new Error('truncated');
      if (!(x & 0x80)) return;
    }
  }
  /** The length of a vector whose items take a byte or more: no more than the bytes left. */
  count(): number {
    const n = this.u32();
    if (n > this.b.length - this.p) throw new Error('truncated');
    return n;
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
  byte(x: number): void {
    this.room(1);
    this.buf[this.length++] = x;
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
  done(): Uint8Array<ArrayBuffer> {
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
      for (let n = r.count(); n > 0; n--) {
        // module and field names (`r.p += r.u32()` would add to the position before the length)
        for (let name = 0; name < 2; name++) {
          const length = r.u32();
          r.p += length;
        }
        const kind = r.byte();
        if (kind === 0x00) r.skip();
        else if (kind === 0x01) {
          if (typedReference(r.byte())) return null;
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
          if (typedReference(r.byte())) return null;
          r.byte();
        } else if (kind === 0x04) {
          r.byte();
          r.skip();
        } else return null;
      }
    } else if (id === 5) {
      for (let n = r.count(); n > 0; n--) {
        const flags = r.byte();
        memories.push(flags);
        r.skip();
        if (flags & 1) r.skip();
      }
    }
    if (id === 10) break;
    r.p = end;
  }
  if (memories.length !== 1 || !(memories[0] & SHARED) || memories[0] & MEMORY64) return null;
  return memories[0];
}

// Value types of the temporaries a guarded function gets (after its own locals).
const I32 = 0x7f;
const I64 = 0x7e;
/** The temporaries: an address, two i32 operands, two i64 operands. */
const TEMPS = [I32, I32, I32, I64, I64] as const;
const [A, B, C, X, Y] = [0, 1, 2, 3, 4];

/**
 * The bytes each atomic operation (0xFE prefix) accesses, and where its operands after the address
 * go (the temporaries of their types, in order). Order of the read-modify-write groups: i32, i64,
 * i32 8u, i32 16u, i64 8u, i64 16u, i64 32u.
 */
const ATOMICS = (() => {
  const shapes: ({ width: number; slots: number[] } | undefined)[] = [];
  const shape = (width: number, operands: number[]) => {
    const slots: number[] = [];
    let i32s = 0;
    let i64s = 0;
    for (const t of operands) slots.push(t === I32 ? [B, C][i32s++] : [X, Y][i64s++]);
    return { width, slots };
  };
  const widths = [[4, I32], [8, I64], [1, I32], [2, I32], [1, I64], [2, I64], [4, I64]] as const;
  shapes[0x00] = shape(4, [I32]);
  shapes[0x01] = shape(4, [I32, I64]);
  shapes[0x02] = shape(8, [I64, I64]);
  widths.forEach(([width], i) => (shapes[0x10 + i] = shape(width, [])));
  widths.forEach(([width, type], i) => (shapes[0x17 + i] = shape(width, [type])));
  for (let op = 0x1e; op <= 0x4e; op++) {
    const [width, type] = widths[(op - 0x1e) % 7];
    shapes[op] = shape(width, op >= 0x48 ? [type, type] : [type]);
  }
  return shapes;
})();

/** Thrown for an instruction the rewrite does not know: the module is left as it is. */
class Unknown extends Error {}

/** Skips a block type (empty, a value type, or a type index) or a heap type. */
function blockType(r: Reader): void {
  const x = r.b[r.p];
  if (x === 0x63 || x === 0x64) throw new Unknown('typed reference block');
  r.skip();
}

/** Reads a memory argument (alignment, offset): the offset. */
function memarg(r: Reader): number {
  const align = r.u32();
  if (align & 0x40) throw new Unknown('multiple memories');
  return r.u32();
}

// What follows each opcode without a prefix (IMMEDIATES).
const NONE = 1;
const LEB = 2;
const TWO_LEBS = 3;
const BLOCK = 4;
const MEMARG = 5;
const BYTES4 = 6;
const BYTES8 = 7;
const BR_TABLE = 8;
const SELECT_TYPES = 9;
const TRY_TABLE = 10;
/** The immediates of each opcode without a prefix; 0 for one the rewrite does not know. */
const IMMEDIATES = (() => {
  const t = new Uint8Array(256);
  const each = (kind: number, ...ops: number[]) => ops.forEach((op) => (t[op] = kind));
  // 0xd3 ref.eq, 0xd4 ref.as_non_null
  each(NONE, 0x00, 0x01, 0x05, 0x0a, 0x0b, 0x0f, 0x19, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4);
  for (let op = 0x45; op <= 0xc4; op++) t[op] = NONE;
  each(BLOCK, 0x02, 0x03, 0x04, 0x06, 0xd0);
  // 0xd2 ref.func, 0xd5 br_on_null, 0xd6 br_on_non_null
  each(LEB, 0x07, 0x08, 0x09, 0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0x18, 0x3f, 0x40, 0x41, 0x42, 0xd2, 0xd5, 0xd6);
  for (let op = 0x20; op <= 0x26; op++) t[op] = LEB;
  each(TWO_LEBS, 0x11, 0x13);
  for (let op = 0x28; op <= 0x3e; op++) t[op] = MEMARG;
  each(BYTES4, 0x43);
  each(BYTES8, 0x44);
  each(BR_TABLE, 0x0e);
  each(SELECT_TYPES, 0x1c);
  each(TRY_TABLE, 0x1f);
  return t;
})();

/** Skips the immediates of an instruction without a prefix (`op` has been read). */
function skipImmediates(r: Reader, op: number): void {
  switch (IMMEDIATES[op]) {
    case NONE:
      return;
    case LEB:
      return r.skip();
    case TWO_LEBS:
      r.skip();
      return r.skip();
    case BLOCK:
      return blockType(r);
    case MEMARG:
      memarg(r);
      return;
    case BYTES4:
      r.p += 4;
      return;
    case BYTES8:
      r.p += 8;
      return;
    case BR_TABLE:
      // the labels and the default
      for (let n = r.count(); n >= 0; n--) r.skip();
      return;
    case SELECT_TYPES:
      for (let n = r.count(); n > 0; n--) if (typedReference(r.byte())) throw new Unknown('typed select');
      return;
    case TRY_TABLE:
      blockType(r);
      for (let n = r.count(); n > 0; n--) {
        // catch and catch_ref name a tag; each clause names a label
        if (r.byte() <= 1) r.skip();
        r.skip();
      }
      return;
    default:
      throw new Unknown(`opcode 0x${op.toString(16)}`);
  }
}

/** The last SIMD opcode (0xFD prefix) the rewrite knows: relaxed SIMD's. Later ones (FP16's lane operations) may have immediates. */
const LAST_SIMD = 0x113;

/** Skips the immediates of a 0xFC or 0xFD instruction (its prefix and opcode have been read). */
function skipPrefixed(r: Reader, prefix: number, sub: number): void {
  if (prefix === 0xfc) {
    if (sub <= 7) return;
    if (sub === 12 || sub === 14) {
      r.skip();
      r.skip();
      return;
    }
    if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) return r.skip();
    throw new Unknown(`0xfc ${sub}`);
  }
  if (prefix === 0xfd) {
    if (sub > LAST_SIMD) throw new Unknown(`0xfd ${sub}`);
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

/** The end of the check (`check`): i64.add, memory.size, i64.extend_i32_u, i64.const 16, i64.shl, i64.gt_u, if, i32.const 0, memory.grow, drop, end. */
const CHECK_END = new Uint8Array([0x7c, 0x3f, 0x00, 0xad, 0x42, 0x10, 0x86, 0x56, 0x04, 0x40, 0x41, 0x00, 0x40, 0x00, 0x1a, 0x0b]);

/**
 * Emits the check for an access of [address, address + length) where the address is in local
 * `addr` and the length is in local `lengthLocal`, or is `constant` when that is -1: when it ends
 * past what memory.size gives, `memory.grow 0`, which updates the instance's size.
 */
function check(w: Writer, addr: number, lengthLocal: number, constant = 0): void {
  get(w, addr);
  w.byte(0xad); // i64.extend_i32_u
  if (lengthLocal < 0) {
    w.byte(0x42);
    w.s64(constant);
  } else {
    get(w, lengthLocal);
    w.byte(0xad);
  }
  w.bytes(CHECK_END);
}

function set(w: Writer, local: number): void {
  w.byte(0x21);
  w.u32(local);
}
function get(w: Writer, local: number): void {
  w.byte(0x20);
  w.u32(local);
}

/** V8's limit on a function's locals (parameters included): a function the temporaries would take past it is left as it is. */
const MAX_LOCALS = 50_000;

/**
 * One function body, guarded (written to `w`, from its start); null when it has no operation to
 * guard. `params`: how many parameters the function has (its temporaries come after them and its
 * locals).
 */
function guardBody(body: Uint8Array, params: number, w: Writer): Uint8Array<ArrayBuffer> | null {
  // Without a 0xFC or 0xFE byte anywhere (most bodies) there is nothing to guard.
  if (body.indexOf(0xfc) < 0 && body.indexOf(0xfe) < 0) return null;
  const r = new Reader(body);
  let locals = 0;
  const groups = r.count();
  for (let i = 0; i < groups; i++) {
    locals += r.u32();
    if (typedReference(r.byte())) throw new Unknown('typed reference local');
  }
  if (params + locals + TEMPS.length > MAX_LOCALS) throw new Unknown('too many locals');
  const codeStart = r.p;
  const base = params + locals;
  let started = false;
  let copied = codeStart;
  const out = () => {
    if (!started) {
      started = true;
      w.length = 0;
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
    // memory.init (data index, memory), memory.copy (two memories), memory.fill (memory)
    if (op === 0xfc && (sub === 8 || sub === 10 || sub === 11)) {
      r.skip();
      if (sub !== 11) r.skip();
      const o = out();
      o.bytes(body.subarray(copied, at));
      // [dst, value or src or the segment's offset, length]
      set(o, base + C);
      set(o, base + B);
      set(o, base + A);
      check(o, base + A, base + C);
      if (sub === 10) check(o, base + B, base + C);
      get(o, base + A);
      get(o, base + B);
      get(o, base + C);
      o.bytes(body.subarray(at, r.p));
      copied = r.p;
      continue;
    }
    if (op === 0xfe) {
      if (sub === 0x03) {
        r.p += 1;
        continue;
      }
      const shape = ATOMICS[sub];
      if (!shape) throw new Unknown(`atomic 0x${sub.toString(16)}`);
      const offset = memarg(r);
      const o = out();
      o.bytes(body.subarray(copied, at));
      // The operands above the address, last first, into the temporaries of their types.
      const slots = shape.slots;
      for (let i = slots.length - 1; i >= 0; i--) set(o, base + slots[i]);
      set(o, base + A);
      check(o, base + A, -1, offset + shape.width);
      get(o, base + A);
      for (const slot of slots) get(o, base + slot);
      o.bytes(body.subarray(at, r.p));
      copied = r.p;
      continue;
    }
    skipPrefixed(r, op, sub);
  }
  if (!started) return null;
  w.bytes(body.subarray(copied));
  return w.done();
}

function lebLength(b: Uint8Array, p: number): number {
  let n = 1;
  while (b[p++] & 0x80) n++;
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
      for (let n = r.count(); n > 0; n--) {
        if (r.byte() !== 0x60) throw new Unknown('type that is not a function');
        const count = r.count();
        for (let i = 0; i < count; i++) if (typedReference(r.byte())) throw new Unknown('typed reference parameter');
        params.push(count);
        for (let i = r.count(); i > 0; i--) if (typedReference(r.byte())) throw new Unknown('typed reference result');
      }
    } else if (id === 3) {
      for (let n = r.count(); n > 0; n--) funcTypes.push(r.u32());
    }
    r.p = end;
  }
  return { params, funcTypes };
}

/**
 * The module with each bulk memory and atomic operation guarded, when it has a single shared
 * memory; null when it is left as it is (no shared memory, or something the rewrite does not know).
 */
export function guardSharedMemoryGrowth(input: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (input.length < 8 || input.length > MAX_INPUT || input[0] !== 0x00 || input[1] !== 0x61 || input[2] !== 0x73 || input[3] !== 0x6d || input[4] !== 1) return null;
  try {
    if (sharedMemoryFlags(input) === null) return null;
    const { params, funcTypes } = signatures(input);
    const most = input.length * (1 + MAX_GROWTH) + GROWTH_ALLOWANCE;
    const w = new Writer();
    w.bytes(input.subarray(0, 8));
    const r = new Reader(input, 8);
    let changed = false;
    while (r.p < input.length) {
      const start = r.p;
      const id = r.byte();
      const size = r.u32();
      const end = r.p + size;
      if (end > input.length) return null;
      if (id !== 10) {
        w.bytes(input.subarray(start, end));
        r.p = end;
        continue;
      }
      const code = new Writer();
      // Where each guarded body is written before it is copied into the section.
      const body = new Writer();
      const count = r.count();
      code.u32(count);
      for (let i = 0; i < count; i++) {
        const length = r.u32();
        if (r.p + length > end) return null;
        const original = input.subarray(r.p, r.p + length);
        r.p += length;
        const guarded = guardBody(original, params[funcTypes[i]], body);
        const chosen = guarded ?? original;
        if (guarded) changed = true;
        code.u32(chosen.length);
        code.bytes(chosen);
        if (w.length + code.length > most) return null;
      }
      if (r.p !== end) return null;
      const section = code.done();
      w.byte(10);
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

/** The bytes of `source`, a buffer or a view of one; null for anything else, and for a detached buffer. */
function bytesOf(source: unknown): Uint8Array | null {
  try {
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    if (source instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && source instanceof SharedArrayBuffer)) return new Uint8Array(source);
  } catch {
    // detached: WebAssembly reports it (a CompileError)
  }
  return null;
}

/**
 * Compiles `source` guarded, with `compile` (native). A guarded module that does not compile is
 * compiled from the bytes it was given, so that the program gets WebAssembly's own error for them
 * (the rewrite keeps a valid module valid; an invalid one's error would name other offsets). When
 * the compile is `later` (a promise), those bytes are copied first, as WebAssembly copies them: the
 * program may change its buffer once the call returns.
 */
function compileGuarded<R>(source: unknown, compile: (bytes: unknown) => R, later: boolean): R {
  const bytes = bytesOf(source);
  const guarded = bytes && guardSharedMemoryGrowth(bytes);
  if (!guarded) return compile(source);
  if (later) {
    const given = bytes.slice();
    return (compile(guarded) as Promise<unknown>).catch((e: unknown) => (e instanceof WebAssembly.CompileError ? compile(given) : Promise.reject(e))) as R;
  }
  try {
    return compile(guarded);
  } catch (e) {
    if (e instanceof WebAssembly.CompileError) return compile(source);
    throw e;
  }
}

let installed = false;

/**
 * Compiles modules with shared memory guarded (guardSharedMemoryGrowth): `new WebAssembly.Module`,
 * `WebAssembly.compile` and `WebAssembly.instantiate` from bytes, with whatever else they are given
 * (compile options such as `builtins`). A compiled module passed on to another thread is already
 * guarded. The streaming forms compile as they are.
 */
export function installWasmGrowGuard(): void {
  if (installed) return;
  installed = true;
  const wasm = WebAssembly as unknown as Record<string, unknown>;
  const NativeModule = WebAssembly.Module;
  const nativeCompile = WebAssembly.compile.bind(WebAssembly) as (source: unknown, ...rest: unknown[]) => Promise<WebAssembly.Module>;
  const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly) as (source: unknown, ...rest: unknown[]) => Promise<unknown>;
  // A function rather than a subclass, so that modules made elsewhere (another thread's) are still
  // `instanceof WebAssembly.Module`; its statics (exports, imports, customSections) are inherited.
  const Module = function Module(this: unknown, source: BufferSource, ...rest: unknown[]) {
    if (!new.target) throw new TypeError("Class constructor Module cannot be invoked without 'new'");
    const target = new.target;
    return compileGuarded(source, (bytes) => Reflect.construct(NativeModule, [bytes, ...rest], target) as WebAssembly.Module, false);
  } as unknown as typeof WebAssembly.Module;
  Object.setPrototypeOf(Module, NativeModule);
  Object.defineProperty(Module, 'prototype', { value: NativeModule.prototype, writable: false });
  Object.defineProperty(wasm, 'Module', { value: Module, writable: true, configurable: true, enumerable: false });
  wasm.compile = function compile(source: BufferSource, ...rest: unknown[]) {
    return compileGuarded(source, (bytes) => nativeCompile(bytes, ...rest), true);
  };
  wasm.instantiate = function instantiate(source: unknown, ...rest: unknown[]) {
    return source instanceof NativeModule ? nativeInstantiate(source, ...rest) : compileGuarded(source, (bytes) => nativeInstantiate(bytes, ...rest), true);
  };
}
