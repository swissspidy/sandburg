/**
 * TypeScript 7's lib/tsc.js in the browser runtime (install-rules.ts, TSC_SHIM): `--showConfig` is
 * answered in JavaScript. The expected output is what TypeScript 7.0's tsc prints for the same files,
 * less the options tsc derives from others (moduleResolution and moduleDetection from module).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TSC_SHIM, WASM_BUILDS } from '../../src/adapters/node/install-rules.ts';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-shim-'));
  const ts = join(dir, 'node_modules', 'typescript');
  mkdirSync(join(ts, 'lib'), { recursive: true });
  writeFileSync(join(ts, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', type: 'module' }));
  writeFileSync(join(ts, 'lib', 'tsc.js'), TSC_SHIM);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const showConfig = (dir: string, cwd: string, ...args: string[]) =>
  JSON.parse(execFileSync(process.execPath, [join(dir, 'node_modules/typescript/lib/tsc.js'), '--showConfig', ...args], { cwd, encoding: 'utf8' }));

test('TypeScript 7 is swapped for tsrs, pinned', () => {
  const build = WASM_BUILDS.find((b) => b.name === 'typescript');
  assert.equal(build?.wasm, '@tsrs/wasm');
  assert.match(build?.wasmVersion ?? '', /^\d+\.\d+\.\d+-ts7\./);
  assert.ok(build?.applies('7.0.2'));
  assert.ok(!build?.applies('6.0.3'), 'TypeScript 6 has its JavaScript compiler');
});

test('--showConfig applies extends, as tsc prints it', () => {
  const dir = project({
    'base/tsconfig.base.json': `{
      // shared settings
      "compilerOptions": {
        "target": "ES2022", /* upper case, as people write it */
        "module": "NodeNext",
        "strict": true,
        "baseUrl": "./src",
        "outDir": "\${configDir}/dist",
        "lib": ["dom", "esnext",],
      },
      "exclude": ["node_modules"],
    }`,
    'app/tsconfig.json': `{
      "extends": "../base/tsconfig.base.json",
      "compilerOptions": {
        "jsx": "react-jsx",
        "paths": { "@/*": ["./*"] }, // "a // in a string" stays
        "plugins": [{ "name": "next" }]
      },
      "include": ["**/*.ts"]
    }`,
  });
  assert.deepEqual(showConfig(dir, join(dir, 'app'), '--project', 'tsconfig.json', '--pretty', 'false'), {
    compilerOptions: {
      target: 'es2022',
      module: 'nodenext',
      strict: true,
      baseUrl: '../base/src',
      outDir: './dist',
      lib: ['dom', 'esnext'],
      jsx: 'react-jsx',
      paths: { '@/*': ['./*'] },
    },
    exclude: ['../base/node_modules'],
    include: ['**/*.ts'],
  });
});

test('--showConfig prefixes inherited files, include and exclude with their config\'s directory', () => {
  const dir = project({
    'base/tsconfig.base.json': JSON.stringify({ include: ['src/**/*.ts', './lib'], exclude: ['node_modules', '${configDir}/out'], files: ['main.ts'] }),
    'app/tsconfig.json': JSON.stringify({ extends: '../base/tsconfig.base.json', compilerOptions: { strict: false } }),
  });
  const config = showConfig(dir, join(dir, 'app'), '-p', 'tsconfig.json');
  // As tsc 7.0 prints them, except that tsc also expands files to the files include matches.
  assert.deepEqual(config.include, ['../base/src/**/*.ts', '../base/./lib']);
  assert.deepEqual(config.exclude, ['../base/node_modules', `${join(dir, 'app')}/out`]);
  assert.deepEqual(config.files, ['../base/main.ts']);
});

test('--showConfig finds tsconfig.json in a --project directory, and a package an extends names', () => {
  const dir = project({
    'node_modules/@tsconfig/strictest/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
    'node_modules/@tsconfig/strictest/package.json': JSON.stringify({ name: '@tsconfig/strictest', version: '2.0.0' }),
    'tsconfig.json': JSON.stringify({ extends: '@tsconfig/strictest/tsconfig.json', compilerOptions: { noUncheckedIndexedAccess: false } }),
  });
  assert.deepEqual(showConfig(dir, dir, '-p', '.').compilerOptions, { strict: true, noUncheckedIndexedAccess: false });
});

test('--showConfig reports an extends cycle instead of looping', () => {
  const dir = project({
    'a.json': JSON.stringify({ extends: './b.json' }),
    'b.json': JSON.stringify({ extends: './a.json' }),
  });
  assert.throws(
    () => execFileSync(process.execPath, [join(dir, 'node_modules/typescript/lib/tsc.js'), '--showConfig', '-p', 'a.json'], { cwd: dir, stdio: 'pipe' }),
    (e: { stderr: Buffer }) => /circularity detected/.test(e.stderr.toString()),
  );
});

test('--showConfig exits once it has printed, as tsc does, whatever else the event loop has', () => {
  const dir = project({ 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' });
  // A timer that would keep the process alive: the runtime ends a process only after its loop has
  // stayed idle for a while (next dev waits for this one as it starts).
  const out = execFileSync(process.execPath, ['--import', 'data:text/javascript,setInterval(() => {}, 1000)', join(dir, 'node_modules/typescript/lib/tsc.js'), '--showConfig'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  assert.deepEqual(JSON.parse(out).compilerOptions, { strict: true });
});
