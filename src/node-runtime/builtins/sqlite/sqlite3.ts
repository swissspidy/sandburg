/**
 * The sqlite3 package's callback API over SQLite WebAssembly (see core.ts):
 * Database (run/get/all/each/exec/prepare/serialize/close) and Statement.
 * Work runs synchronously underneath and callbacks are called asynchronously
 * in call order, which is what serialize() guarantees in the real package.
 */
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { Handle, bindAll, columnNames, describeError, readRow, safeReset, splitParams, type BindValue, type FileAccess, type OoStmt } from './core.ts';

type Callback = (this: unknown, err: Error | null, ...rest: unknown[]) => void;

const OPEN_READONLY = 0x1;
const OPEN_READWRITE = 0x2;
const OPEN_CREATE = 0x4;

function convert(v: unknown): BindValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return String(v);
}

export function createSqlite3(files: FileAccess) {
  function error(handle: Handle | null, e: unknown): Error {
    const info = describeError(e, handle ?? undefined);
    if (!info) return e as Error;
    return Object.assign(new Error(`${info.primary}: ${info.message}`), { errno: info.errno, code: info.primary });
  }

  /** Splits (params..., callback) arguments. */
  function args(list: unknown[]): { params: unknown[]; cb?: Callback } {
    const cb = typeof list[list.length - 1] === 'function' ? (list.pop() as Callback) : undefined;
    return { params: list, cb };
  }

  const later = (fn: () => void) => setTimeout(fn, 0);

  class Statement extends EventEmitter {
    private db: Database;
    private stmt: OoStmt | null = null;
    private names: string[] = [];
    private bound: unknown[] = [];
    lastID?: number;
    changes?: number;
    readonly sql: string;

    constructor(db: Database, sql: string, ...rest: unknown[]) {
      super();
      this.db = db;
      this.sql = sql;
      const { params, cb } = args(rest);
      this.db._queue(() => {
        try {
          this.stmt = db._handle!.db.prepare(sql);
          this.names = columnNames(this.stmt);
          if (params.length) this.bound = params;
          cb?.call(this, null);
        } catch (e) {
          const err = error(db._handle, e);
          if (cb) cb.call(this, err);
          else this.emit('error', err);
        }
      });
    }

    private exec(params: unknown[], each: (row: unknown) => void): void {
      if (!this.stmt) throw new Error('SQLITE_MISUSE: Statement is already finalized');
      const { positional, named } = splitParams(params.length ? params : this.bound);
      this.stmt.reset(true);
      bindAll(this.stmt, positional, named, convert, { prefixedKeys: true });
      try {
        while (this.stmt.step()) each(readRow(this.stmt, this.names, 'object', Buffer.from, false));
      } finally {
        safeReset(this.stmt);
      }
    }

    bind(...rest: unknown[]) {
      const { params, cb } = args(rest);
      this.db._queue(() => {
        this.bound = params;
        cb?.call(this, null);
      });
      return this;
    }

    reset(cb?: Callback) {
      this.db._queue(() => {
        this.stmt?.reset();
        cb?.call(this, null);
      });
      return this;
    }

    run(...rest: unknown[]) {
      const { params, cb } = args(rest);
      this.db._queue(() => {
        try {
          this.exec(params, () => {});
          this.db._handle!.touch();
          this.lastID = Number(this.db._handle!.lastInsertRowid(false));
          this.changes = this.db._handle!.changes();
          cb?.call(this, null);
        } catch (e) {
          this.db._fail(error(this.db._handle, e), cb, this);
        }
      });
      return this;
    }

    get(...rest: unknown[]) {
      const { params, cb } = args(rest);
      this.db._queue(() => {
        try {
          let first: unknown;
          let seen = false;
          this.exec(params, (row) => {
            if (!seen) first = row;
            seen = true;
          });
          cb?.call(this, null, first);
        } catch (e) {
          this.db._fail(error(this.db._handle, e), cb, this);
        }
      });
      return this;
    }

    all(...rest: unknown[]) {
      const { params, cb } = args(rest);
      this.db._queue(() => {
        try {
          const rows: unknown[] = [];
          this.exec(params, (row) => rows.push(row));
          cb?.call(this, null, rows);
        } catch (e) {
          this.db._fail(error(this.db._handle, e), cb, this);
        }
      });
      return this;
    }

    each(...rest: unknown[]) {
      // each(params..., rowCallback, [completeCallback])
      const fns = rest.filter((a) => typeof a === 'function') as Callback[];
      const params = rest.filter((a) => typeof a !== 'function');
      const [onRow, onDone] = fns;
      this.db._queue(() => {
        let count = 0;
        try {
          this.exec(params, (row) => {
            count++;
            onRow?.call(this, null, row);
          });
          onDone?.call(this, null, count);
        } catch (e) {
          this.db._fail(error(this.db._handle, e), onRow, this);
        }
      });
      return this;
    }

    finalize(cb?: Callback) {
      this.db._queue(() => {
        // Closing the database already finalized its statements.
        if (this.db.open) this.stmt?.finalize();
        this.stmt = null;
        cb?.call(this.db, null);
      });
      return this.db;
    }
  }

  class Database extends EventEmitter {
    _handle: Handle | null = null;
    open = false;
    readonly filename: string;
    private jobs: (() => void)[] = [];
    private scheduled = false;

    constructor(filename: string, mode?: number | Callback, cb?: Callback) {
      super();
      if (typeof mode === 'function') {
        cb = mode;
        mode = undefined;
      }
      const flags = mode ?? OPEN_READWRITE | OPEN_CREATE;
      this.filename = filename;
      this._queue(() => {
        try {
          this._handle = new Handle(filename, files, { create: (flags & OPEN_CREATE) !== 0 });
          this.open = true;
          cb?.call(this, null);
          this.emit('open');
        } catch (e) {
          const err = Object.assign(new Error(`SQLITE_CANTOPEN: ${(e as Error).message}`), { errno: 14, code: 'SQLITE_CANTOPEN' });
          if (cb) cb.call(this, err);
          else this.emit('error', err);
        }
      });
    }

    /** Runs jobs in call order, each in its own macrotask (as the native queue calls back). */
    _queue(job: () => void) {
      this.jobs.push(job);
      if (this.scheduled) return;
      this.scheduled = true;
      const drain = () => {
        const next = this.jobs.shift();
        if (next) next();
        if (this.jobs.length) later(drain);
        else this.scheduled = false;
      };
      later(drain);
    }

    _fail(err: Error, cb: Callback | undefined, self: unknown) {
      if (cb) cb.call(self, err);
      else this.emit('error', err);
    }

    run(sql: string, ...rest: unknown[]) {
      const { params, cb } = args(rest);
      const stmt = new Statement(this, sql, (err: Error | null) => err && this._fail(err, cb, stmt));
      stmt.run(...params, function (this: Statement, err: Error | null) {
        stmt.finalize();
        cb?.call(this, err);
      });
      return this;
    }

    get(sql: string, ...rest: unknown[]) {
      const { params, cb } = args(rest);
      const stmt = new Statement(this, sql, (err: Error | null) => err && this._fail(err, cb, stmt));
      stmt.get(...params, function (this: Statement, err: Error | null, row: unknown) {
        stmt.finalize();
        cb?.call(this, err, row);
      });
      return this;
    }

    all(sql: string, ...rest: unknown[]) {
      const { params, cb } = args(rest);
      const stmt = new Statement(this, sql, (err: Error | null) => err && this._fail(err, cb, stmt));
      stmt.all(...params, function (this: Statement, err: Error | null, rows: unknown) {
        stmt.finalize();
        cb?.call(this, err, rows);
      });
      return this;
    }

    each(sql: string, ...rest: unknown[]) {
      const stmt = new Statement(this, sql);
      stmt.each(...rest);
      stmt.finalize();
      return this;
    }

    exec(sql: string, cb?: Callback) {
      this._queue(() => {
        try {
          this._handle!.db.exec(sql);
          this._handle!.touch();
          cb?.call(this, null);
        } catch (e) {
          this._fail(error(this._handle, e), cb, this);
        }
      });
      return this;
    }

    prepare(sql: string, ...rest: unknown[]) {
      return new Statement(this, sql, ...rest);
    }

    serialize(fn?: () => void) {
      fn?.();
      return this;
    }

    parallelize(fn?: () => void) {
      fn?.();
      return this;
    }

    configure() {
      return this;
    }

    interrupt() {}

    wait(cb?: Callback) {
      this._queue(() => cb?.call(this, null));
      return this;
    }

    loadExtension(_path: string, cb?: Callback) {
      this._queue(() => this._fail(new Error('Loading SQLite extensions is not supported in the browser runtime'), cb, this));
      return this;
    }

    close(cb?: Callback) {
      this._queue(() => {
        this._handle?.close();
        this.open = false;
        cb?.call(this, null);
        this.emit('close');
      });
    }
  }

  const cached = {
    objects: new Map<string, Database>(),
    Database(file: string, mode?: number | Callback, cb?: Callback) {
      let db = cached.objects.get(file);
      if (!db) cached.objects.set(file, (db = new Database(file, mode, cb)));
      else if (typeof (typeof mode === 'function' ? mode : cb) === 'function') setTimeout(() => (typeof mode === 'function' ? mode : cb)!.call(db, null), 0);
      return db;
    },
  };
  const mod = {
    Database,
    Statement,
    cached,
    OPEN_READONLY,
    OPEN_READWRITE,
    OPEN_CREATE,
    OPEN_FULLMUTEX: 0x10000,
    OPEN_URI: 0x40,
    OPEN_SHAREDCACHE: 0x20000,
    OPEN_PRIVATECACHE: 0x40000,
    VERSION: '3.53.0',
    SOURCE_ID: 'sqlite-wasm',
    VERSION_NUMBER: 3053000,
    OK: 0,
    ERROR: 1,
    BUSY: 5,
    CONSTRAINT: 19,
    verbose() {
      return mod;
    },
  };
  return mod;
}
