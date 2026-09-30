/**
 * better-sqlite3's API over SQLite WebAssembly (see core.ts): Database,
 * Statement (run/get/all/iterate, pluck/raw/expand/safeIntegers, columns),
 * transactions with savepoints, pragma, user functions, serialize, and
 * SqliteError with SQLite's extended codes (SQLITE_CONSTRAINT_UNIQUE, …).
 */
import { Buffer } from 'buffer';
import { Handle, bindAll, columnNames, describeError, readRow, safeReset, splitParams, sqlite, type BindValue, type FileAccess, type OoStmt } from './core.ts';

export class SqliteError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SqliteError';
    this.code = code;
  }
}

function convert(v: unknown): BindValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
}

export function createBetterSqlite3(files: FileAccess) {
  function wrapError(handle: Handle, e: unknown): Error {
    if (e instanceof RangeError || e instanceof TypeError || e instanceof SqliteError) return e;
    const info = describeError(e, handle);
    return info ? new SqliteError(info.message, info.code) : (e as Error);
  }

  class Statement {
    readonly database: Database;
    readonly source: string;
    readonly reader: boolean;
    readonly readonly: boolean;
    busy = false;
    private stmt: OoStmt;
    private names: string[];
    private mode: 'object' | 'array' = 'object';
    private plucked = false;
    private expanded = false;
    private bigints: boolean;
    private bound: unknown[] | null = null;

    constructor(db: Database, source: string, stmt: OoStmt) {
      this.database = db;
      this.source = source;
      this.stmt = stmt;
      this.names = columnNames(stmt);
      this.reader = stmt.columnCount > 0;
      this.readonly = /^\s*(select|with|pragma|explain|values)\b/i.test(source) && !/\b(insert|update|delete|replace)\b/i.test(source.replace(/'[^']*'/g, ''));
      this.bigints = db._safeIntegers;
    }

    private prepared(args: unknown[]): OoStmt {
      if (this.bound && args.length) throw new TypeError('This statement already has bound parameters');
      const { positional, named } = splitParams(this.bound ?? args);
      this.stmt.reset(true);
      bindAll(this.stmt, positional, named, convert, { strictCount: true });
      return this.stmt;
    }

    private row(): unknown {
      if (this.plucked) return (readRow(this.stmt, this.names, 'array', Buffer.from, this.bigints) as unknown[])[0];
      if (this.expanded) {
        const values = readRow(this.stmt, this.names, 'array', Buffer.from, this.bigints) as unknown[];
        const out: Record<string, Record<string, unknown>> = {};
        this.columns().forEach((c, i) => ((out[c.table ?? '$'] ??= {})[c.name] = values[i]));
        return out;
      }
      return readRow(this.stmt, this.names, this.mode, Buffer.from, this.bigints);
    }

    run(...args: unknown[]) {
      if (this.reader) throw new TypeError('This statement returns data. Use get(), all(), or iterate() instead');
      const handle = this.database._handle;
      try {
        const stmt = this.prepared(args);
        while (stmt.step());
        stmt.reset();
      } catch (e) {
        safeReset(this.stmt);
        throw wrapError(handle, e);
      }
      handle.touch();
      return { changes: handle.changes(), lastInsertRowid: handle.lastInsertRowid(this.bigints) };
    }

    get(...args: unknown[]) {
      if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
      const handle = this.database._handle;
      try {
        const stmt = this.prepared(args);
        const row = stmt.step() ? this.row() : undefined;
        stmt.reset();
        return row;
      } catch (e) {
        safeReset(this.stmt);
        throw wrapError(handle, e);
      }
    }

    all(...args: unknown[]) {
      if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
      const handle = this.database._handle;
      try {
        const stmt = this.prepared(args);
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(this.row());
        stmt.reset();
        return rows;
      } catch (e) {
        safeReset(this.stmt);
        throw wrapError(handle, e);
      }
    }

    *iterate(...args: unknown[]) {
      if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
      const stmt = this.prepared(args);
      this.busy = true;
      try {
        while (stmt.step()) yield this.row();
      } catch (e) {
        throw wrapError(this.database._handle, e);
      } finally {
        this.busy = false;
        safeReset(stmt);
      }
    }

    pluck(on = true) {
      if (!this.reader) throw new TypeError('The pluck() method is only for statements that return data');
      this.plucked = on;
      if (on) this.expanded = false;
      return this;
    }

    expand(on = true) {
      if (!this.reader) throw new TypeError('The expand() method is only for statements that return data');
      this.expanded = on;
      if (on) this.plucked = false;
      return this;
    }

    raw(on = true) {
      if (!this.reader) throw new TypeError('The raw() method is only for statements that return data');
      this.mode = on ? 'array' : 'object';
      if (on) this.plucked = this.expanded = false;
      return this;
    }

    safeIntegers(on = true) {
      this.bigints = on;
      return this;
    }

    bind(...args: unknown[]) {
      if (this.bound) throw new TypeError('The bind() method can only be invoked once per statement object');
      this.prepared(args);
      this.bound = args;
      return this;
    }

    columns() {
      if (!this.reader) throw new TypeError('The columns() method is only for statements that return data');
      const { capi } = sqlite();
      return this.names.map((name, i) => ({ name, column: null as string | null, table: null as string | null, database: 'main', type: capi.sqlite3_column_decltype?.(this.stmt.pointer, i) ?? null }));
    }
  }

  type TxFn = ((...args: unknown[]) => unknown) & { deferred: TxFn; immediate: TxFn; exclusive: TxFn; default: TxFn; database: Database };

  class Database {
    readonly name: string;
    readonly memory: boolean;
    readonly readonly: boolean;
    _safeIntegers = false;
    _handle: Handle;
    private savepoints = 0;

    constructor(filename: string | Buffer = ':memory:', options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number; verbose?: (sql: string) => void; nativeBinding?: unknown } = {}) {
      if (filename instanceof Uint8Array) {
        // new Database(buffer): an in-memory copy of a serialized database.
        this._handle = new Handle(':memory:', files);
        const { capi, wasm } = sqlite();
        const p = wasm.allocFromTypedArray(filename);
        capi.sqlite3_deserialize(this._handle.pointer, 'main', p, filename.length, filename.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
        filename = ':memory:';
      } else {
        const name = String(filename);
        const dir = files.resolve(name).replace(/\/[^/]*$/, '') || '/';
        if (name !== ':memory:' && name !== '' && !files.exists(dir)) throw new TypeError('Cannot open database because the directory does not exist');
        try {
          this._handle = new Handle(name, files, { create: !options.readonly && !options.fileMustExist });
        } catch (e) {
          throw new SqliteError((e as Error).message, (e as { code?: string }).code ?? 'SQLITE_CANTOPEN');
        }
      }
      this.name = String(filename);
      this.memory = this.name === ':memory:' || this.name === '';
      this.readonly = !!options.readonly;
      if (options.verbose) {
        const verbose = options.verbose;
        const prepare = this.prepare.bind(this);
        this.prepare = (sql: string) => {
          verbose(sql);
          return prepare(sql);
        };
      }
    }

    get open() {
      return !this._handle.closed;
    }

    get inTransaction() {
      return !this._handle.closed && this._handle.inTransaction;
    }

    prepare(sql: string): Statement {
      let stmt: OoStmt;
      try {
        stmt = this._handle.db.prepare(sql);
      } catch (e) {
        throw wrapError(this._handle, e);
      }
      return new Statement(this, sql, stmt);
    }

    exec(sql: string) {
      try {
        this._handle.db.exec(sql);
      } catch (e) {
        throw wrapError(this._handle, e);
      }
      this._handle.touch();
      return this;
    }

    pragma(source: string, options: { simple?: boolean } = {}) {
      const stmt = this.prepare(`PRAGMA ${source}`);
      if (!stmt.reader) {
        stmt.run();
        return options.simple ? undefined : [];
      }
      return options.simple ? stmt.pluck().get() : stmt.all();
    }

    transaction(fn: (...args: unknown[]) => unknown): TxFn {
      if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function');
      const make = (begin: string): TxFn => {
        const tx = ((...args: unknown[]) => {
          const nested = this.inTransaction;
          const savepoint = `\`_bs3.${++this.savepoints}\``;
          this.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
          try {
            const result = fn(...args);
            if (result && typeof (result as Promise<unknown>).then === 'function') throw new TypeError('Transaction function cannot return a promise');
            this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
            return result;
          } catch (e) {
            if (this.inTransaction) this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
            throw e;
          } finally {
            this.savepoints--;
          }
        }) as TxFn;
        return tx;
      };
      const tx = make('BEGIN');
      tx.default = tx;
      tx.deferred = make('BEGIN DEFERRED');
      tx.immediate = make('BEGIN IMMEDIATE');
      tx.exclusive = make('BEGIN EXCLUSIVE');
      for (const t of [tx.deferred, tx.immediate, tx.exclusive]) Object.assign(t, { default: tx, deferred: tx.deferred, immediate: tx.immediate, exclusive: tx.exclusive });
      tx.database = this;
      return tx;
    }

    function(name: string, options: unknown, fn?: (...args: unknown[]) => unknown) {
      const opts = (typeof options === 'function' ? {} : (options as { deterministic?: boolean; varargs?: boolean })) ?? {};
      const impl = (typeof options === 'function' ? options : fn) as (...args: unknown[]) => unknown;
      this._handle.db.createFunction({
        name,
        xFunc: (_ctx: number, ...args: unknown[]) => {
          const r = impl(...args);
          return typeof r === 'boolean' ? Number(r) : r;
        },
        arity: opts.varargs ? -1 : impl.length,
        deterministic: !!opts.deterministic,
      });
      return this;
    }

    aggregate(): never {
      throw new TypeError('db.aggregate() is not supported in the browser runtime');
    }

    loadExtension(): never {
      throw new TypeError('Loading SQLite extensions is not supported in the browser runtime');
    }

    serialize() {
      return Buffer.from(sqlite().capi.sqlite3_js_db_export(this._handle.pointer));
    }

    async backup(destination: string) {
      files.write(files.resolve(destination), sqlite().capi.sqlite3_js_db_export(this._handle.pointer));
      return { totalPages: 0, remainingPages: 0 };
    }

    defaultSafeIntegers(on = true) {
      this._safeIntegers = on;
      return this;
    }

    unsafeMode() {
      return this;
    }

    close() {
      this._handle.close();
      return this;
    }
  }
  const exported = Database as unknown as Record<string, unknown>;
  exported.SqliteError = SqliteError;
  exported.default = Database;
  return Database;
}
