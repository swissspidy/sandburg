import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { adapterNames, chooseRuntime } from '../../src/adapters.ts';
import { loadProject } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

test('--runtime auto picks the runtime that suits each project', async () => {
  const expected: Record<string, string> = {
    'vite-react-counter': 'esbuild',
    'svelte-vite': 'esbuild',
    'vue-express-sqlite': 'esbuild',
    'react-express-split': 'esbuild',
    'angular-tasks': 'angular',
    'next-app-router': 'node',
    'node-express': 'node',
    'sveltekit-app': 'node',
    'astro-app': 'node',
    'nuxt-app': 'node',
    'react-router-app': 'node',
    'solid-start-app': 'node',
  };
  const actual: Record<string, string> = {};
  for (const name of Object.keys(expected)) actual[name] = chooseRuntime(await loadProject(fixture(name)));
  assert.deepEqual(actual, expected);
});

test('the runtimes are auto, node, esbuild and angular', () => {
  assert.deepEqual([...adapterNames].sort(), ['angular', 'auto', 'esbuild', 'node']);
});
