import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformForRuntime } from '../../src/adapters/node/install.ts';
import './await-context-stub.ts'; // compiled code runs here

// nitropack 2.13's dev server, as published.
const NITRO_GET_WORKER = `class DevServer {
  workers = [];
  building = true;
  async getWorker() {
    let retry = 0;
    const maxRetries = isTest || isCI ? 100 : 10;
    while (this.building || ++retry < maxRetries) {
      if ((this.workers.length === 0 || this.buildError) && !this.building) {
        return;
      }
      const activeWorker = this.workers.find((w) => w.ready);
      if (activeWorker) {
        return activeWorker;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 600));
    }
  }
}
export const make = (isTest, isCI) => new DevServer();
`;

test("Nitro's dev server checks for a ready worker every 50 ms, for as long as before", async () => {
  const out = await transformForRuntime(NITRO_GET_WORKER, 'node_modules/nitropack/dist/core/index.mjs', true);
  assert.match(out, /setTimeout\(resolve2, 50\)/);
  assert.doesNotMatch(out, /setTimeout\(resolve2, 600\)/);
  assert.match(out, /\(isTest \|\| isCI \? 100 : 10\) \* 12/);
  // Other files are left alone.
  const other = await transformForRuntime(NITRO_GET_WORKER, 'node_modules/other/dist/core/index.mjs', true);
  assert.match(other, /setTimeout\(resolve2, 600\)/);
});

// @solidjs/start 2.1's server functions plugin, as published (dist/directives/index.js).
const SOLID_DEBOUNCER = `class Debouncer {
    source;
    promise;
    timeout;
    constructor(source) {
        this.source = source;
        this.promise = createDeferredPromise();
        this.defer();
    }
    defer() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        this.timeout = setTimeout(() => {
            this.promise.resolve(this.source());
        }, 1000);
    }
}
export { Debouncer };
`;

test("SolidStart's server functions manifest waits 100 ms for more server functions, not 1 s", async () => {
  const out = await transformForRuntime(SOLID_DEBOUNCER, 'node_modules/@solidjs/start/dist/directives/index.js', true);
  assert.match(out, /\}, 100\);/);
  assert.doesNotMatch(out, /1000/);
});

// vite-plugin-solid 2.11's transform hook, as published (dist/esm/index.mjs).
const SOLID_PLUGIN = `import * as babel from '@babel/core';
import { mergeAndConcat } from 'merge-anything';
export default function solidPlugin(options = {}) {
  return {
    async transform(source, id, transformOptions) {
      const isSsr = Boolean(transformOptions?.ssr);
      const opts = { filename: id };
      let babelUserOptions = {};
      const babelOptions = mergeAndConcat(babelUserOptions, opts);
      const {
        code,
        map
      } = await babel.transformAsync(source, babelOptions);
      return {
        code,
        map
      };
    }
  };
}
`;

test("vite-plugin-solid looks its Babel compiles up in the project's transform cache, unless the app passes Babel options", async () => {
  const out = await transformForRuntime(SOLID_PLUGIN, 'node_modules/vite-plugin-solid/dist/esm/index.mjs', true);
  assert.match(out, /options\.babel \? void 0 : globalThis\[\/\* @__PURE__ \*\/ Symbol\.for\("sandburg\.transformCache"\)\]/);
  assert.match(out, /sandburgCache\?\.get\("vite-plugin-solid", id, isSsr, source\)/);
  assert.match(out, /if \(sandburgHit\) return sandburgHit;/);
  assert.match(out, /sandburgCache\?\.set\("vite-plugin-solid", id, isSsr, source, \{ code, map \}\)/);
  const cjs = await transformForRuntime(SOLID_PLUGIN.replace('mergeAndConcat(', 'mergeAnything.mergeAndConcat(').replace('babel.transformAsync', 'babel__namespace.transformAsync'), 'node_modules/vite-plugin-solid/dist/cjs/index.cjs', false);
  assert.match(cjs, /sandburgCache\?\.get\("vite-plugin-solid", id, isSsr, source\)/);
});

// @solidjs/start 2.1's file-system router, as published (dist/config/fs-routes/router.js), without its imports.
const SOLID_ROUTER = `
class BaseFileSystemRouter extends EventTarget {
    routes = [];
    glob() {
        return "src/routes/**/*.tsx";
    }
    async buildRoutes() {
        for (var src of glob(this.glob())) {
            await this.addRoute(src);
        }
        return this.routes;
    }
    async addRoute(src) {
        this.routes.push(src);
        this.reload(src, "add");
    }
    reload(route, type) {
        this.dispatchEvent(new CustomEvent("reload", {
            detail: {
                route,
                type,
            },
        }));
    }
}
module.exports = BaseFileSystemRouter;
`;

test("SolidStart's router tells no one about the routes it lists first, and tells about later changes", async () => {
  const out = await transformForRuntime(SOLID_ROUTER, 'node_modules/@solidjs/start/dist/config/fs-routes/router.js', false);
  const module = { exports: {} as new () => EventTarget & { buildRoutes(): Promise<string[]>; addRoute(src: string): Promise<void> } };
  new Function('module', 'exports', 'glob', out)(module, module.exports, () => ['src/routes/index.tsx', 'src/routes/about.tsx']);
  const router = new module.exports();
  const events: string[] = [];
  router.addEventListener('reload', (e) => events.push((e as CustomEvent<{ route: string; type: string }>).detail.route));
  assert.deepEqual(await router.buildRoutes(), ['src/routes/index.tsx', 'src/routes/about.tsx']);
  assert.deepEqual(events, []);
  await router.addRoute('src/routes/new.tsx');
  assert.deepEqual(events, ['src/routes/new.tsx']);
});

// rolldown 1.2's makeBuiltinPluginCallable (dist/shared/normalize-string-or-regex-*.mjs), as published,
// over a stand-in for the WebAssembly binding's callable plugin, which has every hook.
const ROLLDOWN_CALLABLE = `
class BindingCallableBuiltinPlugin {
	constructor(options) { this.options = options; }
	resolveId() { return null; }
	load() { return null; }
	transform() { return null; }
	watchChange() {}
	getOrder() { return undefined; }
}
const import_binding = { BindingCallableBuiltinPlugin };
const error = (e) => { throw e; };
const logPluginError = (e) => e;
function bindingifyBuiltInPlugin(plugin) {
	return { __name: plugin.name, options: plugin._options };
}
function makeBuiltinPluginCallable(plugin) {
	let callablePlugin = new import_binding.BindingCallableBuiltinPlugin(bindingifyBuiltInPlugin(plugin));
	const wrappedPlugin = plugin;
	for (const key of ["resolveId", "load", "transform", "watchChange"]) {
		const wrappedHook = async function(...args) {
			try {
				return await callablePlugin[key](...args);
			} catch (e) {
				return error(logPluginError(e, plugin.name, { hook: key }));
			}
		};
		const order = callablePlugin.getOrder(key);
		if (order == void 0) wrappedPlugin[key] = wrappedHook;
		else wrappedPlugin[key] = {
			handler: wrappedHook,
			order
		};
	}
	return wrappedPlugin;
}
module.exports = makeBuiltinPluginCallable;
`;

test("rolldown's builtin plugins keep only their own hooks, with filters no narrower than the plugin's own test", async () => {
  const out = await transformForRuntime(ROLLDOWN_CALLABLE, 'node_modules/rolldown/dist/shared/normalize-string-or-regex-DUkI3MrN.mjs', false);
  const module = { exports: {} as (p: object) => Record<string, unknown> };
  new Function('module', 'exports', out)(module, module.exports);
  const callable = (name: string, options?: object) => module.exports({ name, _options: options });
  const hooks = (p: Record<string, unknown>) => ['resolveId', 'load', 'transform', 'watchChange'].filter((k) => k in p);
  const filter = (p: Record<string, unknown>, hook: string) => (p[hook] as { filter?: { id?: RegExp; code?: string[] } }).filter;

  const json = callable('builtin:vite-json', {});
  assert.deepEqual(hooks(json), ['transform']);
  const jsonIds = filter(json, 'transform')!.id!;
  for (const id of ['/a/b.json', '/a/b.json?import', '/a/b.json?commonjs-prox']) assert.ok(jsonIds.test(id), id);
  for (const id of ['/a/b.js', '/a/b.jsonc', '/a/json.ts']) assert.ok(!jsonIds.test(id), id);

  const runtime = callable('builtin:oxc-runtime');
  assert.deepEqual(hooks(runtime), ['resolveId', 'load']);
  // The binding is asked (its stand-in answers null) only for a helper, or ./… from a helper.
  const resolve = runtime.resolveId as (id: string, importer?: string) => Promise<unknown> | null;
  assert.equal(resolve('vue', '/app/src/main.ts'), null);
  assert.equal(resolve('./App.vue', '/app/src/main.ts'), null);
  assert.ok(resolve('@oxc-project/runtime/helpers/decorate', '/app/src/main.ts') instanceof Promise);
  assert.ok(resolve('./typeof.js', '\0@oxc-project+runtime@0.155.0/helpers/esm/decorate.js') instanceof Promise);
  assert.ok(filter(runtime, 'load')!.id!.test('\0@oxc-project+runtime@0.155.0/helpers/esm/decorate.js'));
  assert.ok(!filter(runtime, 'load')!.id!.test('/app/src/main.ts'));

  const replace = callable('builtin:replace', { values: { 'import.meta.server': 'true', 'import.meta.client': 'false' }, preventAssignment: true });
  assert.deepEqual(hooks(replace), ['transform']);
  assert.deepEqual(filter(replace, 'transform')!.code, ['import.meta.server', 'import.meta.client']);
  // objectGuards replaces typeof forms the keys do not contain: no code filter.
  const guarded = callable('builtin:replace', { values: { 'process.env.NODE_ENV': '"x"' }, objectGuards: true });
  assert.equal(typeof guarded.transform, 'function');

  const viteResolve = callable('builtin:vite-resolve', {});
  assert.deepEqual(hooks(viteResolve), ['resolveId', 'load', 'watchChange']);
  for (const id of ['\0vite:esm-external-builtin-require:fs', '__vite-browser-external', '__vite-browser-external:fs', '__vite-optional-peer-dep:a:b']) assert.ok(filter(viteResolve, 'load')!.id!.test(id), id);
  assert.ok(!filter(viteResolve, 'load')!.id!.test('/app/src/main.ts'));
  assert.deepEqual(hooks(callable('builtin:vite-react-refresh-wrapper', {})), ['resolveId', 'transform']);
  // A builtin plugin this does not know keeps every hook.
  assert.deepEqual(hooks(callable('builtin:something-new', {})), ['resolveId', 'load', 'transform', 'watchChange']);
});

// rollup 4's watch Task constructor (dist/es/shared/watch.js), as published, reduced.
const ROLLUP_TASK = `class Task {
    constructor(watcher, options) {
        this.cache = { modules: [] };
        this.watchFiles = [];
    }
}
module.exports = Task;
`;

test("rollup's watch mode starts from the cache it is given", async () => {
  const out = await transformForRuntime(ROLLUP_TASK, 'node_modules/rollup/dist/es/shared/watch.js', false);
  const module = { exports: {} as new (w: unknown, o: { cache?: unknown }) => { cache: unknown } };
  new Function('module', 'exports', out)(module, module.exports);
  const given = { modules: [{ id: '/a.js' }] };
  assert.equal(new module.exports(null, { cache: given }).cache, given);
  assert.deepEqual(new module.exports(null, {}).cache, { modules: [] });
  assert.deepEqual(new module.exports(null, { cache: true }).cache, { modules: [] });
});

// nitropack 2.13's startRollupWatcher (dist/core/index.mjs), as published, over stand-ins for rollup,
// defu and the runtime's transform cache.
const NITRO_WATCHER = `function startRollupWatcher(nitro, rollupConfig) {
  const watcher = rollup.watch(
    defu$1(rollupConfig, {
      watch: {
        chokidar: nitro.options.watchOptions
      }
    })
  );
  let start;
  watcher.on("event", (event) => {
    switch (event.code) {
      case "BUNDLE_END": {
        nitro.hooks.callHook("compiled", nitro);
        break;
      }
      case "ERROR": {
        nitro.logger.error(formatRollupError(event.error));
        nitro.hooks.callHook("dev:error", event.error);
      }
    }
  });
  return watcher;
}
const formatRollupError = (e) => String(e);
module.exports = startRollupWatcher;
`;

test("Nitro's dev build starts from the project's rollup cache and keeps it when a module changed", async () => {
  const out = await transformForRuntime(NITRO_WATCHER, 'node_modules/nitropack/dist/core/index.mjs', false);
  const files = new Map<string, string>();
  const store = { getFile: (_s: string, n: string) => files.get(n) ?? null, setFile: (_s: string, n: string, t: string) => void files.set(n, t) };
  (globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.transformCache')] = store;
  try {
    let config: { cache?: { modules: { id: string; code: string }[] } } = {};
    let emit: (e: unknown) => void = () => {};
    const rollup = { watch: (c: typeof config) => ((config = c), { on: (_: string, f: typeof emit) => (emit = f) }) };
    const defu = (a: object, b: object) => ({ ...b, ...a });
    const module = { exports: {} as (nitro: unknown, config: object) => void };
    new Function('module', 'exports', 'rollup', 'defu$1', out)(module, module.exports, rollup, defu);
    const nitro = { options: { watchOptions: {} }, hooks: { callHook() {} }, logger: { error() {} } };
    const built = (modules: { id: string; code: string }[]) => emit({ code: 'BUNDLE_END', result: { cache: { modules } } });
    // No cache yet: the build's is kept.
    module.exports(nitro, { input: 'x' });
    assert.equal(config.cache, undefined);
    built([{ id: '/a.js', code: 'a' }]);
    assert.deepEqual(JSON.parse(files.get('cache.json')!), { modules: [{ id: '/a.js', code: 'a' }] });
    // The next start gets it; a build with the same modules writes nothing, one with a change does.
    module.exports(nitro, { input: 'x' });
    assert.deepEqual(config.cache, { modules: [{ id: '/a.js', code: 'a' }] });
    files.set('cache.json', 'unchanged marker');
    built([{ id: '/a.js', code: 'a' }]);
    assert.equal(files.get('cache.json'), 'unchanged marker');
    built([{ id: '/a.js', code: 'b' }]);
    assert.deepEqual(JSON.parse(files.get('cache.json')!), { modules: [{ id: '/a.js', code: 'b' }] });
    // A start from the cache whose build fails leaves none for the next.
    module.exports(nitro, { input: 'x' });
    assert.ok(config.cache);
    emit({ code: 'ERROR', error: new Error('broken') });
    assert.equal(files.get('cache.json'), 'null');
    module.exports(nitro, { input: 'x' });
    assert.equal(config.cache, undefined);
  } finally {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.transformCache')];
  }
});
