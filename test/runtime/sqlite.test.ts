/**
 * SQLite in the node runtime (ADR 0009): better-sqlite3, sqlite3 and
 * node:sqlite over the official SQLite WebAssembly build. The installed
 * packages are stood in for by their package.json (their native code is
 * never loaded).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
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
