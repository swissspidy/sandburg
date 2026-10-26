import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '../../lint/sandburg-plugin.ts';

// The rules of lint/sandburg-plugin.ts, each with code it must refuse and code it must let through.
RuleTester.describe = (text, fn) => void describe(text, fn);
RuleTester.it = (text, fn) => void it(text, fn);
const tester = new RuleTester({ languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } } });
type RuleArg = Parameters<RuleTester['run']>[1];
const rule = (name: keyof typeof plugin.rules) => plugin.rules[name] as unknown as RuleArg;

tester.run('cache-key-digest', rule('cache-key-digest'), {
  valid: [
    // Keyed by a digest, under the cache directory.
    `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path'; import { createHash } from 'node:crypto';
     export async function put(cacheDir: string, name: string, body: string) {
       const key = createHash('sha256').update(name).digest('hex');
       await writeFile(join(cacheDir, key), body);
     }`,
    // A name, with a digest beside it.
    `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
     export async function put(cacheDir: string, name: string, digest: string) { await writeFile(join(cacheDir, \`\${name}-\${digest}.json\`), ''); }`,
    // Not a cache: a run's own results.
    `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
     export async function put(outDir: string, name: string) { await writeFile(join(outDir, name), ''); }`,
    // A map in a function is not long-lived.
    `export function f(name: string) { const cache = new Map(); cache.set(name, 1); return cache; }`,
  ],
  invalid: [
    {
      code: `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
             export async function put(cacheDir: string, rel: string, body: string) { const file = join(cacheDir, rel); await writeFile(file, body); }`,
      errors: [{ message: /built from `rel`, which an app controls/ }],
    },
    {
      code: `import * as fs from 'node:fs';
             export function put(pkg: { name: string }) { fs.mkdirSync(\`.sandburg/bundles/\${pkg.name}\`); }`,
      errors: 1,
    },
    {
      code: `import { rename } from 'node:fs/promises'; import { resolve } from 'node:path';
             export async function put(tmp: string, specifier: string) { await rename(tmp, resolve('.sandburg/store', specifier.toLowerCase())); }`,
      errors: 1,
    },
    {
      code: `const resolvedCache = new Map<string, string>();
             export function remember(request: string, file: string) { resolvedCache.set(request, file); }`,
      errors: [{ message: /The key of resolvedCache/ }],
    },
    {
      code: `export class C { private compileCache = new Map<string, string>(); put(path: string, out: string) { this.compileCache.set(\`\${path}\\0\`, out); } }`,
      errors: 1,
    },
  ],
});

tester.run('one-host-server', rule('one-host-server'), {
  valid: [
    `import { request } from 'node:http'; export const r = request('http://x');`,
    `import * as http from 'node:http'; export const a = new http.Agent();`,
  ],
  invalid: [
    { code: `import { createServer } from 'node:http'; createServer(() => {}).listen(0);`, errors: [{ message: /createServer\(\): the host listens with one server/ }] },
    { code: `import http from 'http'; http.createServer(() => {});`, errors: 1 },
    { code: `import * as net from 'node:net'; net.createServer();`, errors: 1 },
    { code: `import { createSecureServer } from 'node:http2'; createSecureServer({});`, errors: 1 },
    { code: `import { Server } from 'node:https'; new Server();`, errors: 1 },
  ],
});

tester.run('no-write-in-place', rule('no-write-in-place'), {
  valid: [
    // replaceFile: removed first, in the same block.
    `import { rm, writeFile } from 'node:fs/promises'; export async function f(path: string) { await rm(path, { force: true }); await writeFile(path, ''); }`,
    `import { rmSync, writeFileSync, chmodSync } from 'node:fs'; export function f(path: string) { rmSync(path); writeFileSync(path, ''); chmodSync(path, 0o755); }`,
    // Under a temporary name, then renamed.
    `import { rename, writeFile } from 'node:fs/promises'; export async function f(file: string) { const tmp = \`\${file}.\${process.pid}.tmp\`; await writeFile(tmp, ''); await rename(tmp, file); }`,
    // Exclusive: fails on a path that exists.
    `import { writeFile } from 'node:fs/promises'; export async function f(path: string) { await writeFile(path, '', { flag: 'wx' }); }`,
    `import { openSync } from 'node:fs'; export const fd = (path: string) => openSync(path, 'r');`,
  ],
  invalid: [
    { code: `import { writeFile } from 'node:fs/promises'; export async function f(path: string) { await writeFile(path, ''); }`, errors: [{ message: /writeFile\(path\) may change a file in place/ }] },
    { code: `import * as fs from 'node:fs'; export function f(path: string) { fs.appendFileSync(path, 'x'); }`, errors: 1 },
    { code: `import fs from 'node:fs'; export async function f(path: string) { await fs.promises.writeFile(path, 'x'); }`, errors: 1 },
    { code: `import { promises } from 'node:fs'; export async function f(path: string) { await promises.truncate(path); }`, errors: 1 },
    { code: `import { chmodSync } from 'node:fs'; export function f(path: string) { chmodSync(path, 0o755); }`, errors: 1 },
    { code: `import { openSync } from 'node:fs'; export const fd = (path: string) => openSync(path, 'r+');`, errors: 1 },
    // Removed in another block (another function) is not removed first.
    { code: `import { rm, writeFile } from 'node:fs/promises'; export async function f(path: string) { if (Math.random()) { await rm(path); } await writeFile(path, ''); }`, errors: 1 },
  ],
});
