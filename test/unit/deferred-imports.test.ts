import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformForRuntime } from '../../src/adapters/node/install.ts';

// astro 7's dist/assets/svg/svgo.js, as published.
const ASTRO_SVGO = `import { optimize } from "svgo";
/** SVG optimizer using [SVGO](https://svgo.dev/). */
export function svgoOptimizer(config) {
	return {
		name: "svgo",
		optimize: (contents, path) => optimize(contents, {
			...config,
			path
		}).data
	};
}
`;

/** Runs CommonJS from the transform with a require that records what it loads. */
function evaluate(code: string, modules: Record<string, unknown>) {
  const loaded: string[] = [];
  const module = { exports: {} as Record<string, unknown> };
  const require = (id: string) => {
    loaded.push(id);
    return modules[id];
  };
  new Function('exports', 'require', 'module', code)(module.exports, require, module);
  return { exports: module.exports, loaded };
}

test("Astro's svgo optimizer loads svgo when it first optimizes, not when the config loads", async () => {
  const out = await transformForRuntime(ASTRO_SVGO, 'node_modules/astro/dist/assets/svg/svgo.js', true);
  const svgo = { optimize: (s: string, o: { path: string }) => ({ data: `${s}:${o.path}` }) };
  const { exports, loaded } = evaluate(out, { svgo });
  assert.deepEqual(loaded, []);
  const optimizer = (exports.svgoOptimizer as (c: object) => { optimize(c: string, p: string): string })({});
  assert.equal(optimizer.optimize('<svg/>', 'a.svg'), '<svg/>:a.svg');
  assert.equal(optimizer.optimize('<svg/>', 'b.svg'), '<svg/>:b.svg');
  assert.deepEqual(loaded, ['svgo'], 'loaded once, at first use');
});

test('a deferred namespace reads as the module (default and named imports)', async () => {
  const source = `import def, { named } from "svgo";\nexport const read = () => [def(), named, typeof def];\n`;
  const out = await transformForRuntime(source, 'node_modules/astro/dist/assets/svg/svgo.js', true);
  // A default import of CommonJS is its module.exports, as in Node (esbuild's __toESM in node mode).
  const { exports, loaded } = evaluate(out, { svgo: Object.assign(() => 'd', { named: 'n' }) });
  assert.deepEqual(loaded, []);
  assert.deepEqual((exports.read as () => unknown[])(), ['d', 'n', 'function']);
  assert.deepEqual(loaded, ['svgo']);
});

test('imports are deferred only in the listed files, and only the listed ones', async () => {
  const source = `import { optimize } from "svgo";\nimport { other } from "other";\nexport const f = () => [optimize, other];\n`;
  const listed = await transformForRuntime(source, 'node_modules/astro/dist/assets/svg/svgo.js', true);
  assert.deepEqual(evaluate(listed, { svgo: {}, other: {} }).loaded, ['other']);
  const elsewhere = await transformForRuntime(source, 'node_modules/not-astro/dist/assets/svg/svgo.js', true);
  assert.deepEqual(evaluate(elsewhere, { svgo: {}, other: {} }).loaded, ['svgo', 'other']);
  assert.doesNotMatch(elsewhere, /__sandburgDefer/);
});
