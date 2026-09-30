/**
 * node:sqlite (DatabaseSync, StatementSync) over SQLite WebAssembly (see core.ts),
 * with Node's defaults: foreign keys on, bare named parameters allowed, rows
 * as null-prototype objects, errors with code ERR_SQLITE_ERROR.
 */
import { Handle, bindAll, columnNames, describeError, readRow, safeReset, splitParams, type BindValue, type FileAccess, type OoStmt } from './core.ts';

function sqliteError(handle: Handle, e: unknown): Error {
  const info = describeError(e, handle);
  if (!info) return e as Error;
  return Object.assign(new Error(info.message), { code: 'ERR_SQLITE_ERROR', errcode: info.errno, errstr: info.message });
}

function convert(v: unknown): BindValue {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  throw Object.assign(new TypeError(`Provided value cannot be bound to SQLite parameter`), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createNodeSqlite(files: FileAccess) {
  class StatementSync {
    private handle: Handle;
    private stmt: OoStmt;
    private names: string[];
    private bigints = false;
    private arrays = false;
    private bare = true;
    readonly sourceSQL: string;

    constructor(handle: Handle, sql: string, stmt: OoStmt) {
      this.handle = handle;
      this.stmt = stmt;
      this.sourceSQL = sql;
      this.names = columnNames(stmt);
    }

    get expandedSQL() {
      return this.sourceSQL;
    }

    private bind(args: unknown[]) {
      const { positional, named } = splitParams(args);
      this.stmt.reset(true);
      bindAll(this.stmt, positional, named, convert, { prefixedKeys: true, strictCount: false });
      if (!this.bare && named && Object.keys(named).some((k) => !/^[:@$]/.test(k))) throw Object.assign(new Error('Unknown named parameter'), { code: 'ERR_INVALID_STATE' });
    }

    private row() {
      return readRow(this.stmt, this.names, this.arrays ? 'array' : 'null-proto', (u) => new Uint8Array(u), this.bigints);
    }

    run(...args: unknown[]) {
      try {
        this.bind(args);
        while (this.stmt.step());
        this.stmt.reset();
      } catch (e) {
        safeReset(this.stmt);
        throw sqliteError(this.handle, e);
      }
      this.handle.touch();
      return { changes: this.handle.changes(), lastInsertRowid: this.handle.lastInsertRowid(this.bigints) };
    }

    get(...args: unknown[]) {
      try {
        this.bind(args);
        const row = this.stmt.step() ? this.row() : undefined;
        this.stmt.reset();
        if (!this.names.length) this.handle.touch();
        return row;
      } catch (e) {
        safeReset(this.stmt);
        throw sqliteError(this.handle, e);
      }
    }

    all(...args: unknown[]) {
      try {
        this.bind(args);
        const rows: unknown[] = [];
        while (this.stmt.step()) rows.push(this.row());
        this.stmt.reset();
        if (!this.names.length) this.handle.touch();
        return rows;
      } catch (e) {
        safeReset(this.stmt);
        throw sqliteError(this.handle, e);
      }
    }

    *iterate(...args: unknown[]) {
      this.bind(args);
      try {
        while (this.stmt.step()) yield this.row();
      } catch (e) {
        throw sqliteError(this.handle, e);
      } finally {
        safeReset(this.stmt);
      }
    }

    columns() {
      return this.names.map((name) => ({ column: null, database: 'main', name, table: null, type: null }));
    }

    setReadBigInts(on: boolean) {
      this.bigints = on;
    }

    setReturnArrays(on: boolean) {
      this.arrays = on;
    }

    setAllowBareNamedParameters(on: boolean) {
      this.bare = on;
    }

    setAllowUnknownNamedParameters() {}
  }

  class DatabaseSync {
    private handle: Handle | null = null;
    private readonly path: string;
    private readonly options: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean };

    constructor(path: string | URL | Uint8Array, options: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean; timeout?: number } = {}) {
      this.path = path instanceof URL ? path.pathname : typeof path === 'string' ? path : new TextDecoder().decode(path);
      this.options = options;
      if (options.open !== false) this.open();
    }

    open() {
      if (this.handle && !this.handle.closed) throw Object.assign(new Error('database is already open'), { code: 'ERR_INVALID_STATE' });
      this.handle = new Handle(this.path, files, { create: !this.options.readOnly });
      if (this.options.enableForeignKeyConstraints !== false) this.handle.db.exec('PRAGMA foreign_keys = ON');
    }

    get isOpen() {
      return !!this.handle && !this.handle.closed;
    }

    get isTransaction() {
      return this.isOpen && this.h.inTransaction;
    }

    private get h(): Handle {
      if (!this.handle || this.handle.closed) throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
      return this.handle;
    }

    exec(sql: string) {
      try {
        this.h.db.exec(sql);
      } catch (e) {
        throw sqliteError(this.h, e);
      }
      this.h.touch();
    }

    prepare(sql: string) {
      try {
        return new StatementSync(this.h, sql, this.h.db.prepare(sql));
      } catch (e) {
        throw sqliteError(this.h, e);
      }
    }

    function(name: string, options: unknown, fn?: (...args: unknown[]) => unknown) {
      const impl = (typeof options === 'function' ? options : fn) as (...args: unknown[]) => unknown;
      const opts = (typeof options === 'function' ? {} : options) as { deterministic?: boolean; varargs?: boolean };
      this.h.db.createFunction({ name, xFunc: (_ctx: number, ...args: unknown[]) => impl(...args), arity: opts.varargs ? -1 : impl.length, deterministic: !!opts.deterministic });
    }

    location() {
      return this.h.path;
    }

    close() {
      this.h.close();
    }

    [Symbol.dispose]() {
      if (this.isOpen) this.close();
    }
  }

  return { DatabaseSync, StatementSync, constants: { SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2 } };
}
