/** The node runtime's shell (src/node-runtime/shell.ts): how it splits a script into commands and runs them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, type ShellHost } from '../../src/node-runtime/shell.ts';

type Ran = { argv: string[]; cwd: string; env: Record<string, string>; exit(code: number): void };

/**
 * A script run on a host whose files are `files`: each Node program it starts is recorded and exits
 * with `code(argv)` (null: not until the test says, with its `exit`).
 */
function run(script: string, { files = {}, env = {}, code = () => 0 }: { files?: Record<string, string>; env?: Record<string, string>; code?: (argv: string[]) => number | null } = {}) {
  const ran: Ran[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let exited!: (code: number) => void;
  const exit = new Promise<number>((r) => (exited = r));
  const host: ShellHost = {
    node(argv, opts) {
      const program = { argv, cwd: opts.cwd, env: opts.env, exit: (c: number) => opts.onExit(c) };
      ran.push(program);
      const c = code(argv);
      if (c !== null) queueMicrotask(() => program.exit(c));
      return { kill() {} };
    },
    readFile: (path) => files[path] ?? null,
    exists: (path) => Object.keys(files).some((f) => f === path || f.startsWith(`${path}/`)),
    write: (fd, text) => (fd === 1 ? out : err).push(text),
    onExit: (c) => exited(c),
  };
  runScript(script, '/app', env, host);
  return { ran, out, err, exit, argv: () => ran.map((r) => r.argv.slice(1).join(' ')) };
}

const fails = (argv: string[]) => (argv[1].startsWith('fail') ? 1 : 0);

test('&& runs the next command if the last succeeded, || if it failed, ; either way; the script exits as its last command did', async () => {
  const a = run('node a.js && node fail.js && node b.js; node c.js || node d.js; node fail2.js || node e.js', { code: fails });
  assert.equal(await a.exit, 0);
  assert.deepEqual(a.argv(), ['a.js', 'fail.js', 'c.js', 'fail2.js', 'e.js']);
  const b = run('node a.js; node fail.js', { code: fails });
  assert.equal(await b.exit, 1);
  // A command skipped leaves the code of the last one that ran.
  const c = run('node fail.js && node b.js', { code: fails });
  assert.equal(await c.exit, 1);
  assert.deepEqual(c.argv(), ['fail.js']);
  assert.equal(await run('true && false').exit, 1);
  assert.equal(await run('false || exit 3').exit, 3);
});

test('& runs a command in the background: the script goes on, and ends once its background commands end too', async () => {
  const s = run('node seed.js & node server.js', { code: () => null });
  // Both started, the server without waiting for the seed.
  await Promise.resolve();
  assert.deepEqual(s.argv(), ['seed.js', 'server.js']);
  let ended = false;
  void s.exit.then(() => (ended = true));
  s.ran[1].exit(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, false, 'the seed still runs');
  s.ran[0].exit(1);
  // The foreground command's code, not the background one's.
  assert.equal(await s.exit, 0);
});

test('quotes and backslashes keep words whole; variables expand, except in single quotes', async () => {
  const s = run(`node 'a b.js' "x $HOME \\"q\\"" 'y $HOME' c\\ d '' "\${PORT:-3000}" \${HOST}x $NONE end`, { env: { HOME: '/root', HOST: 'h' } });
  await s.exit;
  assert.deepEqual(s.ran[0].argv, ['node', 'a b.js', 'x /root "q"', 'y $HOME', 'c d', '', '3000', 'hx', 'end']);
  // A word that is only an unset variable is no word at all; a lone $ is kept.
  const e = run('echo $ $NONE ${HOME}', { env: { HOME: '/root' } });
  await e.exit;
  assert.deepEqual(e.out, ['$ /root\n']);
});

test('NAME=value before a command sets it for that command; alone, or with export, for the rest of the script', async () => {
  const s = run('PORT=4000 node server.js; node other.js; A=1; export B=2; node last.js', { env: { HOME: '/root' } });
  await s.exit;
  assert.equal(s.ran[0].env.PORT, '4000');
  assert.equal(s.ran[0].env.HOME, '/root');
  assert.equal(s.ran[1].env.PORT, undefined);
  assert.deepEqual([s.ran[2].env.A, s.ran[2].env.B], ['1', '2']);
  // cross-env and env do the same.
  const c = run('cross-env NODE_ENV=production node a.js && env DEBUG=1 node b.js');
  await c.exit;
  assert.deepEqual([c.ran[0].env.NODE_ENV, c.ran[1].env.DEBUG], ['production', '1']);
});

test('sh -c and bash -c run their script in this shell', async () => {
  const s = run(`sh -c "node a.js && node b.js" && bash -c 'cd server; node c.js'`, { files: { '/app/server/c.js': '' } });
  assert.equal(await s.exit, 0);
  assert.deepEqual(s.argv(), ['a.js', 'b.js', 'c.js']);
  assert.equal(s.ran[2].cwd, '/app/server');
  assert.equal(await run(`bash -c 'exit 2'`).exit, 2);
});

test('cd changes the directory of the commands after it; to a directory that is not there, it fails', async () => {
  const s = run('cd server && node index.js; cd .. && node root.js', { files: { '/app/server/index.js': '' } });
  await s.exit;
  assert.deepEqual(
    s.ran.map((r) => r.cwd),
    ['/app/server', '/app'],
  );
  const missing = run('cd nowhere && node a.js');
  assert.equal(await missing.exit, 1);
  assert.deepEqual(missing.ran, []);
  assert.match(missing.err.join(''), /cd: nowhere: No such file or directory/);
});

test('a pipe or a redirection is dropped with a note: the command before it runs alone', async () => {
  const s = run('node a.js | grep ready > out.log && node b.js; node c.js > c.log 2> /dev/null');
  assert.equal(await s.exit, 0);
  assert.deepEqual(s.argv(), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(s.err, [
    'sh: pipes and redirections are not supported; running "node a.js" alone\n',
    'sh: pipes and redirections are not supported; running "node c.js" alone\n',
  ]);
});

test('a command that is not a Node program exits with 127, as sh does for one it cannot find', async () => {
  const s = run('python3 app.py || node fallback.js');
  assert.equal(await s.exit, 0);
  assert.deepEqual(s.argv(), ['fallback.js']);
  assert.match(s.err.join(''), /sh: python3: not found/);
  assert.equal(await run('make').exit, 127);
});

test('a workspace package\'s script runs in its directory: npm -w, pnpm --filter, yarn workspace (by name from the workspace file, or by path)', async () => {
  const files = {
    '/app/package.json': JSON.stringify({ scripts: { dev: 'npm run dev --workspace=web' } }),
    '/app/.sandburg/workspace.json': JSON.stringify({ links: {}, packages: { web: 'apps/web', '@acme/api': 'services/api' } }),
    '/app/apps/web/package.json': JSON.stringify({ scripts: { dev: 'node web.js' } }),
    '/app/services/api/package.json': JSON.stringify({ scripts: { start: 'node api.js' } }),
  };
  for (const script of ['npm run dev', 'npm run dev -w web', 'npm -w apps/web run dev', 'pnpm --filter web dev', 'pnpm -F ./apps/web dev', 'yarn workspace web dev']) {
    const s = run(script, { files });
    assert.equal(await s.exit, 0, script);
    assert.deepEqual(s.ran.map((r) => [r.argv.slice(1).join(' '), r.cwd]), [['web.js', '/app/apps/web']], script);
  }
  const api = run('npm start -w @acme/api', { files });
  assert.equal(await api.exit, 0);
  assert.deepEqual(api.ran.map((r) => r.cwd), ['/app/services/api']);
});

test('every workspace\'s script (npm --workspaces, pnpm -r) is not run, and does not run the root\'s again', async () => {
  const files = { '/app/package.json': JSON.stringify({ scripts: { dev: 'npm run dev --workspaces' } }) };
  const s = run('npm run dev', { files });
  assert.equal(await s.exit, 127);
  assert.deepEqual(s.ran, []);
  assert.equal(await run('pnpm -r dev', { files }).exit, 127);
  assert.equal(await run('npm run dev -w missing', { files }).exit, 127);
});
