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
