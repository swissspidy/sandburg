/**
 * SQLite in the node runtime (ADR 0009): better-sqlite3, sqlite3 and
 * node:sqlite over the official SQLite WebAssembly build. The installed
 * packages are stood in for by their package.json (their native code is
 * never loaded).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

const fakePackage = (name: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: 'lib/index.js' }),
  [`node_modules/${name}/lib/index.js`]: `throw new Error('the native ${name} must not load');`,
});

test('better-sqlite3: statements, named/positional params, transactions, errors, persistence', async () => {
  const out = await h.run(
    {
      ...fakePackage('better-sqlite3'),
      'main.js': `
        const Database = require('better-sqlite3');
        const fs = require('fs');
        const db = new Database('app.db');
        db.pragma('journal_mode = WAL');
        db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, age INTEGER, avatar BLOB)");
        const insert = db.prepare('INSERT INTO users (email, age, avatar) VALUES (@email, @age, @avatar)');
        const first = insert.run({ email: 'a@x.io', age: 30, avatar: Buffer.from([1, 2, 3]) });
        const many = db.transaction((rows) => { for (const r of rows) insert.run(r); return rows.length; });
        const inserted = many([{ email: 'b@x.io', age: 25, avatar: null }, { email: 'c@x.io', age: 41, avatar: null }]);
        let unique; try { insert.run({ email: 'a@x.io', age: 1, avatar: null }); } catch (e) { unique = [e.name, e.code, e.message]; }
        let rolledBack; try { many([{ email: 'd@x.io', age: 1, avatar: null }, { email: 'a@x.io', age: 2, avatar: null }]); } catch { rolledBack = db.prepare('SELECT COUNT(*) FROM users WHERE email = ?').pluck().get('d@x.io'); }
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(first.lastInsertRowid);
        const older = db.prepare('SELECT email FROM users WHERE age > ? ORDER BY age').pluck().all(26);
        const raw = db.prepare('SELECT id, email FROM users ORDER BY id').raw().all();
        const iter = [...db.prepare('SELECT email FROM users').iterate()].length;
        let misuse; try { db.prepare('SELECT 1').run(); } catch (e) { misuse = e.message; }
        let boolBind; try { db.prepare('SELECT ?').get(true); } catch (e) { boolBind = e.constructor.name; }
        db.function('double', (x) => x * 2);
        const doubled = db.prepare('SELECT double(age) AS d FROM users WHERE id = 1').get().d;
        const second = new Database('app.db');
        const shared = second.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        setTimeout(() => {
          console.log(JSON.stringify({
            first: { changes: first.changes, id: first.lastInsertRowid }, inserted, unique, rolledBack,
            row: { ...row, avatar: [...row.avatar], isBuffer: Buffer.isBuffer(row.avatar) }, older, raw, iter, misuse, boolBind, doubled, shared,
            inTx: db.inTransaction, open: db.open, file: fs.statSync('app.db').size > 0,
            header: fs.readFileSync('app.db').subarray(0, 15).toString(),
          }));
        }, 100);`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.deepEqual(r.first, { changes: 1, id: 1 });
  assert.equal(r.inserted, 2);
  assert.deepEqual(r.unique, ['SqliteError', 'SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: users.email']);
  assert.equal(r.rolledBack, 0);
  assert.deepEqual(r.row, { id: 1, email: 'a@x.io', age: 30, avatar: [1, 2, 3], isBuffer: true });
  assert.deepEqual(r.older, ['a@x.io', 'c@x.io']);
  assert.deepEqual(r.raw, [[1, 'a@x.io'], [2, 'b@x.io'], [3, 'c@x.io']]);
  assert.equal(r.iter, 3);
  assert.match(r.misuse, /This statement returns data/);
  assert.equal(r.boolBind, 'TypeError');
  assert.equal(r.doubled, 60);
  assert.equal(r.shared, 3);
  assert.equal(r.inTx, false);
  assert.equal(r.open, true);
  assert.equal(r.file, true);
  assert.equal(r.header, 'SQLite format 3');
});

test('a database written right before process.exit() is in its file for the next process', async () => {
  const out = await h.run(
    {
      ...fakePackage('better-sqlite3'),
      'seed.js': `
        const db = new (require('better-sqlite3'))('seed.db');
        db.exec("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('ada'), ('bob')");
        process.exit(0);`,
      'main.js': `
        require('child_process').execFile('node', ['seed.js'], (err) => {
          const db = new (require('better-sqlite3'))('seed.db');
          console.log(JSON.stringify([err, db.prepare('SELECT name FROM t').all()]));
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()!), [null, [{ name: 'ada' }, { name: 'bob' }]]);
});

test('a process that exits inside a transaction keeps what it committed before, not what the transaction changed', async () => {
  const out = await h.run(
    {
      ...fakePackage('better-sqlite3'),
      'seed.js': `
        const db = new (require('better-sqlite3'))('tx.db');
        db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1); BEGIN; INSERT INTO t VALUES (2)");
        process.exit(0);`,
      'main.js': `
        require('child_process').execFile('node', ['seed.js'], (err) => {
          const db = new (require('better-sqlite3'))('tx.db');
          console.log(JSON.stringify([err, db.prepare('SELECT x FROM t').all()]));
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()!), [null, [{ x: 1 }]]);
});

test('sqlite3: callbacks in order, this.lastID/changes, $params, errors', async () => {
  const out = await h.run(
    {
      ...fakePackage('sqlite3'),
      'main.js': `
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(':memory:');
        const log = [];
        db.serialize(() => {
          db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
          db.run('INSERT INTO t (name) VALUES (?)', ['ada'], function (err) { log.push(['insert', err, this.lastID, this.changes]); });
          db.run('INSERT INTO t (name) VALUES ($name)', { $name: 'bob' });
          db.run('INSERT INTO t (name) VALUES (?)', 'ada', (err) => log.push(['dup', err && err.code, err && err.message]));
          // SQL that cannot be prepared calls back once, with why.
          db.run('INSERT INTO missing VALUES (1)', (err) => log.push(['unprepared', err && err.message]));
          db.all('SELECT nope FROM t', (err, rows) => log.push(['unprepared', err && err.message, rows]));
          db.get('SELECT name FROM t WHERE id = ?', 2, (err, row) => log.push(['get', row]));
          db.all('SELECT name FROM t ORDER BY id', (err, rows) => log.push(['all', rows.map((r) => r.name)]));
          db.each('SELECT id FROM t', (err, row) => log.push(['row', row.id]), (err, n) => log.push(['each', n]));
          db.close(() => console.log(JSON.stringify(log)));
        });`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()!), [
    ['insert', null, 1, 1],
    ['dup', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT: UNIQUE constraint failed: t.name'],
    ['unprepared', 'SQLITE_ERROR: no such table: missing'],
    ['unprepared', 'SQLITE_ERROR: no such column: nope', null],
    ['get', { name: 'bob' }],
    ['all', ['ada', 'bob']],
    ['row', 1],
    ['row', 2],
    ['each', 2],
  ]);
});

test('node:sqlite: DatabaseSync, StatementSync, foreign keys on by default', async () => {
  const out = await h.run(
    {
      'main.mjs': `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (a_id INTEGER REFERENCES a(id))');
        const ins = db.prepare('INSERT INTO a (id) VALUES (:id)');
        const res = ins.run({ id: 7 });
        let fk; try { db.prepare('INSERT INTO b VALUES (?)').run(99); } catch (e) { fk = [e.code, e.message]; }
        const row = db.prepare('SELECT id FROM a').get();
        console.log(JSON.stringify({ res, fk, row, proto: Object.getPrototypeOf(row) === null, all: db.prepare('SELECT id FROM a').all().length }));`,
    },
    '/app/main.mjs',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.deepEqual(r, { res: { changes: 1, lastInsertRowid: 7 }, fk: ['ERR_SQLITE_ERROR', 'FOREIGN KEY constraint failed'], row: { id: 7 }, proto: true, all: 1 });
});

// A project's WAL-mode database (#174), as SQLite on the developer's machine leaves it: one checkpointed
// (no -wal), and one whose last transactions are still in its -wal. Made here by the host's SQLite.
function walDatabases() {
  const dir = mkdtempSync(join(tmpdir(), 'sandburg-wal-'));
  try {
    const clean = new DatabaseSync(join(dir, 'clean.sqlite'));
    clean.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('hello')");
    clean.close();
    const live = new DatabaseSync(join(dir, 'live.sqlite'));
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('one')");
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    live.exec("INSERT INTO items (name) VALUES ('two'); UPDATE items SET name = 'ONE' WHERE id = 1; CREATE TABLE more (x); INSERT INTO more VALUES (42)");
    // Read while the connection is open: closing it checkpoints the -wal into the file and removes it.
    const files = { clean: readFileSync(join(dir, 'clean.sqlite')), live: readFileSync(join(dir, 'live.sqlite')), liveWal: readFileSync(join(dir, 'live.sqlite-wal')) };
    live.close();
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a WAL-mode database opens: checkpointed, or with its -wal\'s transactions; written back in WAL mode, its -wal emptied (#174)', async () => {
  const files = walDatabases();
  const out = await h.run(
    {
      ...fakePackage('better-sqlite3'),
      'main.js': `
        const fs = require('fs');
        const Database = require('better-sqlite3');
        const files = ${JSON.stringify(files)};
        fs.writeFileSync('clean.sqlite', Buffer.from(files.clean, 'base64'));
        fs.writeFileSync('live.sqlite', Buffer.from(files.live, 'base64'));
        fs.writeFileSync('live.sqlite-wal', Buffer.from(files.liveWal, 'base64'));
        const clean = new Database('clean.sqlite').prepare('SELECT * FROM items').all();
        const db = new Database('live.sqlite');
        const live = [db.prepare('SELECT * FROM items ORDER BY id').all(), db.prepare('SELECT x FROM more').pluck().all()];
        db.prepare("INSERT INTO items (name) VALUES ('three')").run();
        db.close();
        const file = fs.readFileSync('live.sqlite');
        console.log(JSON.stringify({ clean, live, header: [file[18], file[19]], wal: fs.statSync('live.sqlite-wal').size, file: file.toString('base64') }));`,
    },
    '/app/main.js',
  );
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.deepEqual(r.clean, [{ id: 1, name: 'hello' }]);
  // As the host's SQLite reads the pair: the -wal's update, insert and new table.
  assert.deepEqual(r.live, [[{ id: 1, name: 'ONE' }, { id: 2, name: 'two' }], [42]]);
  assert.deepEqual(r.header, [2, 2]);
  assert.equal(r.wal, 0);
  // The file written back is one the host's SQLite opens, with everything in it.
  const dir = mkdtempSync(join(tmpdir(), 'sandburg-wal-'));
  try {
    writeFileSync(join(dir, 'back.sqlite'), Buffer.from(r.file, 'base64'));
    const back = new DatabaseSync(join(dir, 'back.sqlite'));
    assert.deepEqual(back.prepare('SELECT name FROM items ORDER BY id').all().map((row) => row.name), ['ONE', 'two', 'three']);
    assert.equal(back.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    back.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
