import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasiPlacements } from '../../src/adapters/node/install-rules.ts';

const rolldown = (version: string) => ({ '@rolldown/binding-wasm32-wasi': version, '@rolldown/binding-linux-x64-gnu': version });

test("each copy of a napi-rs package resolves the WebAssembly binding it lists: Nuxt's rolldown 1.2.19 at the top, Vite 8.4's own 1.3.4 nested in vite", () => {
  const placements = wasiPlacements([
    { location: 'node_modules/vite/node_modules/rolldown', optionalDependencies: rolldown('1.3.4') },
    { location: 'node_modules/rolldown', optionalDependencies: rolldown('1.2.19') },
    { location: 'node_modules/nuxt', optionalDependencies: {} },
  ]);
  assert.deepEqual(Object.fromEntries(placements), {
    'node_modules/@rolldown/binding-wasm32-wasi': '1.2.19',
    // Inside the nested rolldown: only it resolves it (the top's stays the top's).
    'node_modules/vite/node_modules/rolldown/node_modules/@rolldown/binding-wasm32-wasi': '1.3.4',
  });
});

test('a nested copy that lists the same version as the top resolves the top one; one with no copy above it gets it at the top', () => {
  assert.deepEqual(
    Object.fromEntries(
      wasiPlacements([
        { location: 'node_modules/rolldown', optionalDependencies: rolldown('1.3.4') },
        { location: 'node_modules/vite/node_modules/rolldown', optionalDependencies: rolldown('1.3.4') },
        { location: 'node_modules/astro/node_modules/@astrojs/compiler-rs', optionalDependencies: { '@astrojs/compiler-rs-wasm32-wasi': '0.4.0' } },
      ]),
    ),
    { 'node_modules/@rolldown/binding-wasm32-wasi': '1.3.4', 'node_modules/@astrojs/compiler-rs-wasm32-wasi': '0.4.0' },
  );
});

test('a binding already installed is taken as it is, where a package resolves it', () => {
  const packages = [{ location: 'node_modules/rolldown', optionalDependencies: rolldown('1.3.4') }];
  assert.deepEqual(Object.fromEntries(wasiPlacements(packages, new Set(['node_modules/@rolldown/binding-wasm32-wasi']))), {});
  assert.deepEqual(Object.fromEntries(wasiPlacements(packages, new Set(['node_modules/rolldown/node_modules/@rolldown/binding-wasm32-wasi']))), {});
});
