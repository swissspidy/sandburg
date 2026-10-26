import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFramework, FRAMEWORKS } from '../../src/framework.ts';
import type { Framework } from '../../src/types.ts';

// The framework table (src/framework.ts) is the one place a framework is added; these keep the
// rest in step with it. The Framework union in types.ts is checked by the table's type
// (a Record over it): a name in one and not the other does not compile.

test("result-schema.json's framework enum is the table's frameworks and 'unknown'", () => {
  const schema = JSON.parse(readFileSync('src/result-schema.json', 'utf8')) as { properties: { project: { properties: { framework: { enum: string[] } } } } };
  assert.deepEqual(schema.properties.project.properties.framework.enum.sort(), [...Object.keys(FRAMEWORKS), 'unknown'].sort());
});

test('detection: the table in order, frameworks built on Vite before Vite', () => {
  const vite = { vite: '7' };
  const cases: [Framework, Record<string, string>, Record<string, string>, boolean?][] = [
    ['next', { next: '16', react: '19' }, {}],
    ['next', {}, { 'next.config.mjs': '' }],
    ['angular', { '@angular/core': '20', ...vite }, {}],
    ['angular', {}, { 'angular.json': '{}' }],
    ['sveltekit', { '@sveltejs/kit': '2', ...vite, astro: '5' }, {}],
    ['astro', { astro: '5', ...vite }, {}],
    ['astro', {}, { 'astro.config.ts': '' }],
    ['nuxt', { nuxt: '4', ...vite }, {}],
    ['nuxt', {}, { 'nuxt.config.ts': '' }],
    ['solid-start', { '@solidjs/start': '1', ...vite }, {}],
    ['react-router', { '@react-router/dev': '7', ...vite }, {}],
    ['vite', vite, {}],
    ['vite', {}, { 'vite.config.cts': '' }],
    ['static', {}, { 'index.html': '' }, true],
    ['unknown', {}, { 'index.html': '' }],
    ['unknown', { express: '5' }, { 'server.js': '' }],
  ];
  for (const [expected, deps, files, noPackage] of cases) {
    assert.equal(detectFramework(files, noPackage ? null : { devDependencies: deps }), expected, `${JSON.stringify(deps)} ${JSON.stringify(files)}`);
  }
});

test('every framework the Docker reference starts has a dev server command line', () => {
  for (const [name, info] of Object.entries(FRAMEWORKS)) {
    if (!info.reference) continue;
    assert.ok(info.reference.listen('127.0.0.1', 4000).includes('4000'), name);
    assert.match(info.reference.script({ scripts: { dev: 'x' } }), /^(dev|start)$/, name);
  }
});
