/** Which emnapi WebAssembly bindings are installed again with (emnapiToAlign, install-rules.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sideEmnapiOverrides } from '../../src/adapters/node/install.ts';
import { emnapiToAlign } from '../../src/adapters/node/install-rules.ts';

async function tree(packages: Record<string, object>): Promise<string> {
  const side = await mkdtemp(join(tmpdir(), 'sandburg-emnapi-'));
  for (const [path, pkg] of Object.entries(packages)) {
    await mkdir(join(side, 'node_modules', path), { recursive: true });
    await writeFile(join(side, 'node_modules', path, 'package.json'), JSON.stringify(pkg));
  }
  return side;
}

const runtime = (peer: string) => ({ name: '@napi-rs/wasm-runtime', version: '1.2.6', peerDependencies: { '@emnapi/core': peer } });
const core = (version: string) => ({ name: '@emnapi/core', version });

test('the rule: a 2.x emnapi other than the one exact version the runtimes agree on', () => {
  assert.equal(emnapiToAlign([{ peer: '^1.7.1 || 2.0.0-beta.2', core: '2.0.0-alpha.5' }]), '2.0.0-beta.2');
  assert.equal(emnapiToAlign([{ peer: '^1.7.1 || 2.0.0-beta.2', core: '2.0.0-beta.2' }]), null, 'already that one');
  assert.equal(emnapiToAlign([{ peer: '^1.7.1 || 2.0.0-beta.2', core: '1.11.1' }]), null, 'emnapi 1.x loads with any runtime');
  assert.equal(emnapiToAlign([{ peer: '^1.7.1 || ^2.0.0-alpha.4', core: '2.0.0-alpha.5' }]), null, 'a range, no exact version');
  assert.equal(emnapiToAlign([{ peer: '2.0.0-beta.2', core: '2.0.0-alpha.5' }, { peer: '2.0.0-beta.3', core: '2.0.0-beta.3' }]), null, 'runtimes that disagree');
  assert.equal(emnapiToAlign([]), null);
});

test('a side install: overrides scoped to each binding whose runtime needs another emnapi', async () => {
  // As npm lays out rolldown 1.2.15's and satteri 0.10.5's bindings: one runtime at the top, each
  // binding's pinned emnapi nested in it (2.0.0-alpha.5 and 1.11.1).
  const side = await tree({
    '@napi-rs/wasm-runtime': runtime('^1.7.1 || 2.0.0-beta.2'),
    '@rolldown/binding-wasm32-wasi': { version: '1.2.15' },
    '@rolldown/binding-wasm32-wasi/node_modules/@emnapi/core': core('2.0.0-alpha.5'),
    '@bruits/satteri-wasm32-wasi': { version: '0.10.5' },
    '@bruits/satteri-wasm32-wasi/node_modules/@emnapi/core': core('1.11.1'),
    '@other/binding-wasm32-wasi': { version: '1.0.0' },
  });
  try {
    assert.deepEqual(await sideEmnapiOverrides(side, ['@rolldown/binding-wasm32-wasi', '@bruits/satteri-wasm32-wasi', '@other/binding-wasm32-wasi', '@missing/binding']), {
      '@rolldown/binding-wasm32-wasi': { '@emnapi/core': '2.0.0-beta.2', '@emnapi/runtime': '2.0.0-beta.2' },
    });
    assert.equal(await sideEmnapiOverrides(side, ['@bruits/satteri-wasm32-wasi']), null);
  } finally {
    await rm(side, { recursive: true, force: true });
  }
});
