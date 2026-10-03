import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, cleanPath, formatFiles, needsRestart, parseAnswer } from '../../pages/generate/files.ts';
import { TEMPLATES } from '../../pages/generate/templates.ts';
import { zip } from '../../pages/generate/zip.ts';
import { pageInstall } from '../../src/adapters/node/plan.ts';
import { detectFramework } from '../../src/framework.ts';
import { readZip } from '../../src/zip.ts';
import type { PackageJson, Project } from '../../src/types.ts';

test('parses files, deletions and prose from an answer', () => {
  const answer = `A counter.\n\n<file path="src/App.jsx">\nexport default 1;\n</file>\n<file path="./src/x.css">\n\`\`\`css\nbody {}\n\`\`\`\n</file>\n<delete path="src/old.js" />\nDone.`;
  const parsed = parseAnswer(answer);
  assert.deepEqual(parsed.edits, [
    { path: 'src/App.jsx', content: 'export default 1;\n' },
    { path: 'src/x.css', content: 'body {}\n' },
    { path: 'src/old.js', delete: true },
  ]);
  assert.equal(parsed.prose, 'A counter.\n\nDone.');
  assert.equal(parsed.open, null);
});

test('a streaming answer has the file being written open', () => {
  const parsed = parseAnswer('Plan.\n<file path="a.js">\nconst a = 1;\n</file>\n<file path="b.js">\nconst b');
  assert.deepEqual(parsed.edits, [{ path: 'a.js', content: 'const a = 1;\n' }]);
  assert.deepEqual(parsed.open, { path: 'b.js', chars: 'const b'.length + 1 });
  assert.equal(parsed.prose, 'Plan.');
});

test('paths outside the project are rejected', () => {
  assert.equal(cleanPath('../etc/passwd'), null);
  assert.equal(cleanPath('node_modules/x/index.js'), null);
  assert.equal(cleanPath('/src//a.js'), 'src/a.js');
  assert.deepEqual(parseAnswer('<file path="../x">y</file>').rejected, ['../x']);
});

test('edits apply, and only some need a new run', () => {
  const { files, changed, deleted } = applyEdits({ 'a.js': '1', 'b.js': '2' }, [
    { path: 'a.js', content: '1' },
    { path: 'c.js', content: '3' },
    { path: 'b.js', delete: true },
  ]);
  assert.deepEqual(files, { 'a.js': '1', 'c.js': '3' });
  assert.deepEqual(changed, ['c.js']);
  assert.deepEqual(deleted, ['b.js']);
  assert.equal(needsRestart(['src/App.jsx', 'index.html'], []), false);
  assert.equal(needsRestart(['package.json'], []), true);
  assert.equal(needsRestart(['vite.config.js'], []), true);
  assert.equal(needsRestart(['server/index.js'], []), true);
  assert.equal(needsRestart(['server/api/todos.js'], [], 'nuxt'), false);
  assert.equal(needsRestart(['proxy.conf.json'], []), true);
  assert.equal(needsRestart([], ['src/a.js']), true);
});

test('the scaffold, formatted for the model, parses back to itself', () => {
  for (const t of TEMPLATES) {
    const parsed = parseAnswer(formatFiles(t.files));
    assert.deepEqual(Object.fromEntries(parsed.edits.map((e) => [e.path, 'content' in e ? e.content : null])), t.files, t.id);
  }
});

test('each scaffold has a way to start in the page, and a backend with SQLite', () => {
  for (const t of TEMPLATES) {
    const pkg = typeof t.files['package.json'] === 'string' ? (JSON.parse(t.files['package.json']) as PackageJson) : null;
    // A plain Node server (Express) is "unknown" to detection, and starts from its dev script.
    const framework = detectFramework(t.files, pkg);
    assert.ok(framework !== 'unknown' || pkg?.scripts?.dev, t.id);
    const plan = pageInstall({ name: t.id, path: t.id, files: t.files, packageJson: pkg, framework, snapshotId: '' } as Project);
    if (framework === 'next') assert.equal(plan.start, null, t.id);
    else assert.ok(plan.start, t.id);
    if (framework !== 'static') assert.ok(plan.browserInstall?.length, t.id);
    assert.ok(Object.values(t.files).some((c) => typeof c === 'string' && c.includes("from 'node:sqlite'")), t.id);
  }
});

test('a project downloads as a zip with one top folder', () => {
  const entries = readZip(Buffer.from(zip({ 'package.json': '{}', 'src/ü.js': 'x' }, 'app')));
  assert.deepEqual(
    entries.map((e) => [e.path, e.data.toString('utf8')]),
    [
      ['app/package.json', '{}'],
      ['app/src/ü.js', 'x'],
    ],
  );
});
