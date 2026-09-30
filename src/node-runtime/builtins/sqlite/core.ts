/**
 * SQLite for the node runtime (ADR 0009): the official SQLite WebAssembly
 * build (@sqlite.org/sqlite-wasm, loaded on demand) behind the APIs apps use:
 * better-sqlite3, sqlite3 and node:sqlite. Native addons cannot run in the
 * browser; the database engine is the same SQLite.
 *
 * Databases live in memory and are shared per file: every connection to
 * "notes.db" sees the same data, as with a file on disk. After writes the
 * database is serialized back to its file in the virtual file system, so a
 * later process (or fs.readFileSync) sees it, and an existing .db file in the
 * project is loaded when first opened.
 */

/* The parts of the @sqlite.org/sqlite-wasm API used here. */
export interface Sqlite3 {
  capi: {
    sqlite3_changes(db: number): number;
    sqlite3_last_insert_rowid(db: number): number | bigint;
    sqlite3_get_autocommit(db: number): number;
    sqlite3_errmsg(db: number): string;
    sqlite3_extended_errcode(db: number): number;
    sqlite3_js_rc_str(rc: number): string;
    sqlite3_bind_parameter_name(stmt: number, i: number): string | null;
    sqlite3_column_decltype?(stmt: number, i: number): string | null;
    sqlite3_js_db_export(db: number): Uint8Array;
    sqlite3_deserialize(db: number, schema: string, data: number, dbSize: number, bufSize: number, flags: number): number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
  wasm: { allocFromTypedArray(a: Uint8Array): number };
  oo1: { DB: new (filename: string, flags?: string) => OoDb };
  SQLite3Error: new (...a: unknown[]) => Error;
}

export interface OoDb {
  pointer: number;
  prepare(sql: string): OoStmt;
  exec(sql: string): unknown;
  close(): void;
  createFunction(opts: { name: string; xFunc: (ctx: number, ...args: unknown[]) => unknown; arity?: number; deterministic?: boolean }): unknown;
}

export interface OoStmt {
  pointer: number;
  columnCount: number;
  parameterCount: number;
  bind(index: number, value: unknown): OoStmt;
  clearBindings(): OoStmt;
  step(): boolean;
  reset(alsoClearBinds?: boolean): OoStmt;
  finalize(): void;
  get(index: number): unknown;
  getColumnName(i: number): string;
  getColumnNames(): string[];
}

let engine: Sqlite3 | null = null;

/** Loads the engine; the runtime awaits this before running a program that uses SQLite. */
export async function loadSqlite(base: string): Promise<void> {
  if (engine) return;
  (self as unknown as { importScripts(url: string): void }).importScripts(`${base}/sqlite3.js`);
  const init = (self as unknown as { sandburgSqlite3: { default(o: object): Promise<Sqlite3> } }).sandburgSqlite3.default;
  engine = await init({ locateFile: () => `${base}/sqlite3.wasm`, print: () => {}, printErr: () => {} });
  // The engine logs failed steps and similar diagnostics; the native packages do not.
  const config = (engine as unknown as { config?: Record<string, unknown> }).config;
  if (config) for (const k of ['log', 'warn', 'error', 'debug']) config[k] = () => {};
}

export function sqlite(): Sqlite3 {
  if (!engine) throw new Error('SQLite is not loaded (the runtime loads it when the app depends on better-sqlite3, sqlite3 or node:sqlite)');
  return engine;
}

export interface FileAccess {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  write(path: string, data: Uint8Array): void;
  resolve(path: string): string;
}

interface Shared {
  db: OoDb;
  path: string | null;
  refs: number;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const shared = new Map<string, Shared>();

/** A database handle shared by every connection to the same file (or a private one for :memory:). */
export class Handle {
  private s: Shared;
  private files: FileAccess;
  closed = false;

  constructor(filename: string, files: FileAccess, opts: { create?: boolean } = {}) {
    this.files = files;
    const memory = filename === ':memory:' || filename === '' || /^file::memory:/.test(filename);
    const path = memory ? null : files.resolve(filename);
    let s = path ? shared.get(path) : undefined;
    if (!s) {
      if (path && !files.exists(path) && opts.create === false) throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
      const db = new (sqlite().oo1.DB)(':memory:', 'c');
      if (path && files.exists(path)) {
        const bytes = files.read(path);
        if (bytes.length) {
          const { capi, wasm } = sqlite();
          const p = wasm.allocFromTypedArray(bytes);
          const rc = capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
          if (rc !== 0) throw Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
        }
      } else if (path) files.write(path, new Uint8Array());
      s = { db, path, refs: 0, dirty: false, timer: null };
      if (path) shared.set(path, s);
    }
    s.refs++;
    this.s = s;
  }

  get db(): OoDb {
    if (this.closed) throw new TypeError('The database connection is not open');
    return this.s.db;
  }

  get pointer(): number {
    return this.db.pointer;
  }

  get path(): string | null {
    return this.s.path;
  }

  get inTransaction(): boolean {
    return sqlite().capi.sqlite3_get_autocommit(this.s.db.pointer) === 0;
  }

  /** Marks the database changed; it is written back to its file shortly (outside transactions). */
  touch(): void {
    const s = this.s;
    if (!s.path) return;
    s.dirty = true;
    s.timer ??= setTimeout(() => this.flush(), 20);
  }

  flush(): void {
    const s = this.s;
    s.timer = null;
    if (!s.dirty || !s.path) return;
    if (this.inTransaction) {
      s.timer = setTimeout(() => this.flush(), 20);
      return;
    }
    s.dirty = false;
    this.files.write(s.path, sqlite().capi.sqlite3_js_db_export(s.db.pointer));
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (--this.s.refs === 0) {
      if (this.s.path) shared.delete(this.s.path);
      this.s.db.close();
    }
  }

  changes(): number {
    return sqlite().capi.sqlite3_changes(this.pointer);
  }

  lastInsertRowid(bigint: boolean): number | bigint {
    const id = sqlite().capi.sqlite3_last_insert_rowid(this.pointer);
    return bigint ? BigInt(id) : Number(id);
  }

  /** The current error as SQLite reports it: message and extended code name (SQLITE_CONSTRAINT_UNIQUE). */
  lastError(): { message: string; code: string; primary: string; errno: number } {
    const { capi } = sqlite();
    const errno = capi.sqlite3_extended_errcode(this.pointer);
    const code = capi.sqlite3_js_rc_str(errno) ?? 'SQLITE_ERROR';
    const primary = capi.sqlite3_js_rc_str(errno & 0xff) ?? 'SQLITE_ERROR';
    return { message: capi.sqlite3_errmsg(this.pointer), code, primary, errno: errno & 0xff };
  }
}

/** An error thrown by the engine, as SQLite reports it: message, extended code name, primary code name and number. */
export function describeError(e: unknown, handle?: Handle): { message: string; code: string; primary: string; errno: number } | null {
  if (!e || typeof e !== 'object' || ((e as Error).name !== 'SQLite3Error' && typeof (e as { resultCode?: unknown }).resultCode !== 'number')) return null;
  const rc = (e as { resultCode?: number }).resultCode;
  if (typeof rc === 'number' && rc !== 0) {
    const { capi } = sqlite();
    return {
      message: (e as Error).message.replace(/^[A-Z0-9_]+: sqlite3 result code \d+: /, ''),
      code: capi.sqlite3_js_rc_str(rc) ?? 'SQLITE_ERROR',
      primary: capi.sqlite3_js_rc_str(rc & 0xff) ?? 'SQLITE_ERROR',
      errno: rc & 0xff,
    };
  }
  return handle ? handle.lastError() : { message: (e as Error).message, code: 'SQLITE_ERROR', primary: 'SQLITE_ERROR', errno: 1 };
}

/** Resets a statement after a failed step (reset() reports the step's error again; it is already being handled). */
export function safeReset(stmt: OoStmt | null): void {
  try {
    stmt?.reset();
  } catch {
    // the same error
  }
}

/** Column names of a prepared statement (none for statements that return no data). */
export function columnNames(stmt: OoStmt): string[] {
  return stmt.columnCount ? stmt.getColumnNames() : [];
}

export type BindValue = null | number | bigint | string | Uint8Array;

/**
 * Binds parameters the way the APIs do: `?`/`?NNN` take positional values in
 * order; named ones (:name, @name, $name) come from an object, keyed by the
 * bare name (better-sqlite3, node:sqlite) or with the prefix (sqlite3).
 */
export function bindAll(stmt: OoStmt, positional: unknown[], named: Record<string, unknown> | null, convert: (v: unknown) => BindValue, opts: { prefixedKeys?: boolean; strictCount?: boolean }): void {
  const { capi } = sqlite();
  let next = 0;
  for (let i = 1; i <= stmt.parameterCount; i++) {
    const name = capi.sqlite3_bind_parameter_name(stmt.pointer, i);
    let value: unknown;
    if (!name || name.startsWith('?')) {
      if (next >= positional.length) {
        if (opts.strictCount) throw new RangeError('Too few parameter values were provided');
        value = null;
      } else value = positional[next++];
    } else {
      const bare = name.slice(1);
      if (named && opts.prefixedKeys && name in named) value = named[name];
      else if (named && bare in named) value = named[bare];
      else if (opts.strictCount) throw new RangeError(`Missing named parameter "${bare}"`);
      else value = null;
    }
    stmt.bind(i, convert(value));
  }
  if (opts.strictCount && next < positional.length) throw new RangeError('Too many parameter values were provided');
}

/** Splits call arguments into positional values and a named-parameter object (arrays are spread). */
export function splitParams(args: unknown[]): { positional: unknown[]; named: Record<string, unknown> | null } {
  const positional: unknown[] = [];
  let named: Record<string, unknown> | null = null;
  for (const a of args) {
    if (Array.isArray(a)) positional.push(...a);
    else if (a !== null && typeof a === 'object' && !(a instanceof Uint8Array) && !(a instanceof ArrayBuffer) && Object.getPrototypeOf(a) === Object.prototype) named = { ...(named ?? {}), ...(a as Record<string, unknown>) };
    else positional.push(a);
  }
  return { positional, named };
}

/** Reads the current row: column names → values (blobs as Buffers when `toBuffer` is given). */
export function readRow(stmt: OoStmt, names: string[], mode: 'object' | 'array' | 'null-proto', toBuffer: (u: Uint8Array) => unknown, bigints: boolean): unknown {
  const values = names.map((_, i) => {
    let v = stmt.get(i);
    if (v instanceof Uint8Array) v = toBuffer(v);
    else if (bigints && typeof v === 'number' && Number.isInteger(v)) v = BigInt(v);
    else if (!bigints && typeof v === 'bigint') v = Number(v);
    return v;
  });
  if (mode === 'array') return values;
  const row: Record<string, unknown> = mode === 'null-proto' ? Object.create(null) : {};
  names.forEach((n, i) => (row[n] = values[i]));
  return row;
}
