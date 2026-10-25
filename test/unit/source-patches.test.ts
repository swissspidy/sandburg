import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformForRuntime } from '../../src/adapters/node/install.ts';

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
