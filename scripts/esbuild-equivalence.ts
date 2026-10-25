/**
 * Whether the host's native esbuild transforms code as another esbuild version does (ADR NNNN): the
 * versions in NATIVE_VERSIONS (src/node-runtime/native-transform.ts) are the ones this found equal.
 * Transforms every TypeScript and JSX module of corpus/ and fixtures/ with the WebAssembly build of
 * each version given and with the host's esbuild, with Vite's options and with others, and compares
 * code, source maps, warnings and errors. Run it again when the host's esbuild changes.
 *
 *   npm pack esbuild-wasm@0.25.12 && tar xzf esbuild-wasm-0.25.12.tgz
 *   node scripts/esbuild-equivalence.ts package [more esbuild-wasm directories]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', 'corpus', 'fixtures'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(tsx?|jsx)$/.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.spec.ts'));

const optionSets = (file: string, loader: string): esbuild.TransformOptions[] => [
  // Vite 5-7's (vite:esbuild, with @vitejs/plugin-react's JSX).
  { loader: loader as esbuild.Loader, jsx: 'automatic', target: 'esnext', charset: 'utf8', sourcemap: true, sourcefile: file, tsconfigRaw: { compilerOptions: { target: 'ES2020', useDefineForClassFields: true } } },
  { loader: loader as esbuild.Loader, target: 'es2020', format: 'esm', sourcemap: 'external', sourcefile: file, tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  { loader: loader as esbuild.Loader, format: 'cjs', platform: 'node', minify: true, keepNames: true, sourcefile: file },
];

const outcome = async (run: () => Promise<esbuild.TransformResult>) => {
  try {
    const r = await run();
    return JSON.stringify([r.code, r.map, r.warnings]);
  } catch (e) {
    return JSON.stringify(['error', (e as { errors?: unknown }).errors ?? String(e)]);
  }
};

for (const dir of process.argv.slice(2)) {
  const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  // The browser build, in this thread, as the runtime's esbuild shim runs it.
  const mod = { exports: {} as typeof esbuild };
  // oxlint-disable-next-line eslint/no-new-func, typescript/no-implied-eval -- esbuild's browser build, evaluated as the runtime's shim does
  new Function('self', 'module', 'exports', 'require', readFileSync(join(dir, 'lib/browser.js'), 'utf8'))(globalThis, mod, mod.exports, createRequire(import.meta.url));
  const wasm = mod.exports;
  await wasm.initialize({ wasmModule: new WebAssembly.Module(readFileSync(join(dir, 'esbuild.wasm'))), worker: false });
  let same = 0;
  const differ: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const options of optionSets(`/app/${file}`, extname(file).slice(1))) {
      const [a, b] = [await outcome(() => wasm.transform(source, options)), await outcome(() => esbuild.transform(source, options))];
      if (a === b) same++;
      else differ.push(`${file} ${JSON.stringify(options).slice(0, 80)}`);
    }
  }
  console.log(`esbuild ${version} against ${esbuild.version}: ${same} the same, ${differ.length} different${differ.length ? `\n  ${differ.slice(0, 10).join('\n  ')}` : ''}`);
  process.exitCode = differ.length ? 1 : process.exitCode;
  await wasm.stop();
}
process.exit();
