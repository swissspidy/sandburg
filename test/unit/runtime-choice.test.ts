import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { adapterNames, getAdapter } from '../../src/adapters.ts';
import { loadProject } from '../../src/project.ts';
import type { Project } from '../../src/types.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

test('the node runtime is the only runtime', () => {
  assert.deepEqual(adapterNames, ['node']);
  assert.throws(() => getAdapter('esbuild'), /unknown runtime "esbuild"/);
});

test('every fixture can be started on the node runtime', async () => {
  const names = ['vite-react-counter', 'svelte-vite', 'vue-express-sqlite', 'react-express-split', 'vite-socketio-chat', 'angular-tasks', 'angular-zone', 'next-app-router', 'node-express', 'sveltekit-app', 'astro-app', 'nuxt-app', 'react-router-app', 'solid-start-app'];
  for (const name of names) assert.deepEqual(getAdapter('node').probe(await loadProject(fixture(name))), { verdict: 'supported' }, name);
});

test('a project with nothing to start is unsupported', () => {
  const project = { name: 'lib', path: '/x', files: { 'package.json': '{"name":"lib"}' }, packageJson: { name: 'lib' }, framework: 'unknown' } as unknown as Project;
  const probe = getAdapter('node').probe(project);
  assert.equal(probe.verdict, 'unsupported');
});
