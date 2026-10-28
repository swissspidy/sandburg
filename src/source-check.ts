/**
 * The project's own sources, checked without running them (ADR 0067): a file that does not parse,
 * and a package a file imports that the project does not declare. Some dev servers report neither:
 * SolidStart 2.1.0 starts streaming the page, never ends it, and logs nothing. The ready phase asks
 * for this only when it has stalled (failOnSourceStall), and classify() reports what it found.
 *
 * One esbuild build parses every file (every import external, nothing written): a few tens of
 * milliseconds for an app of a few dozen files. Only a JavaScript or TypeScript module's static
 * imports count (not `import()` or `require()`, which an app may guard); TypeScript's elided imports
 * (types, and imports nothing uses) do not, as they do not reach the dev server. Single-file components
 * (.vue, .svelte, .astro) are checked by their scripts, each a module of its own.
 */
import { builtinModules } from 'node:module';
import * as esbuild from 'esbuild';
import type { FileTree } from './types.ts';

/** What the check found in one file, at its line (and column, for a syntax error). */
export interface SourceFinding {
  rule: 'compile-error' | 'undeclared-import';
  /** The file, relative to the project. */
  file: string;
  line: number;
  column?: number;
  /** The parser's message, or the package imported. */
  message: string;
}

/** The file:line[:column] of a finding, then what it is, as classify() reports it. */
export function describeFinding(f: SourceFinding): string {
  const at = `${f.file}:${f.line}${f.column === undefined ? '' : `:${f.column}`}`;
  return f.rule === 'compile-error' ? `${at}: ${f.message}` : `imports undeclared package "${f.message}" (${at})`;
}

const MODULE = /\.(?:[cm]?[jt]sx?)$/;
const COMPONENT = /\.(?:vue|svelte|astro)$/;
/** Not the app's sources: dependencies, generated and built output, static assets, tests and stories, types. */
const SKIPPED = /(?:^|\/)(?:node_modules|\.[^/]+|dist|build|out|coverage|public|static|__tests__|__mocks__|tests?|e2e|cypress|playwright)\/|\.(?:test|spec|stories|story|cy)\.[^/]+$|\.d\.[cm]?ts$/;
const MAX_FILES = 2_000;
const MAX_BYTES = 512 * 1024;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));
/** An npm package name, with its scope (what a bare specifier names before any subpath). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Packages a framework resolves itself, without the app declaring them. */
const PROVIDED = new Set(['server-only', 'client-only', 'styled-jsx']);
const LOADERS: Record<string, esbuild.Loader> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'jsx', mjs: 'jsx', cjs: 'jsx', jsx: 'jsx' };

/** The text of a project's file, or null for one stored as bytes. */
function text(files: FileTree, path: string): string | null {
  const content = files[path];
  return typeof content === 'string' ? content : null;
}

/** The package a bare specifier names, or null for anything else (a relative path, a URL, an alias, a built-in). */
function packageOf(specifier: string): string | null {
  // Relative, absolute, a scheme (node:, virtual:, astro:, https:), subpath imports (#) and aliases (~, $lib, @/).
  if (/^[./#~$]|^@\/|^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return PACKAGE_NAME.test(name) && !BUILTINS.has(name) && !PROVIDED.has(name) ? name : null;
}

/**
 * A component's scripts, each the whole file with everything outside it blanked (newlines kept), so
 * that a line and column in it are the file's: Vue's and Svelte's `<script>` blocks, Astro's
 * frontmatter and its processed `<script>`s (not `is:inline` ones, which the browser runs as they are).
 */
function componentScripts(path: string, code: string): { code: string; loader: esbuild.Loader }[] {
  const blank = (from: number, to: number) => code.slice(0, from).replace(/[^\n]/g, ' ') + code.slice(from, to) + code.slice(to).replace(/[^\n]/g, ' ');
  const scripts: { code: string; loader: esbuild.Loader }[] = [];
  if (path.endsWith('.astro')) {
    const front = /^\s*---[^\n]*\n([\s\S]*?)\n---/d.exec(code);
    const [from, to] = front?.indices?.[1] ?? [];
    if (from !== undefined && to !== undefined) scripts.push({ code: blank(from, to), loader: 'ts' });
  }
  for (const m of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([\w/+-]+)/.exec(attrs)?.[1];
    if (/\bsrc\s*=|\bis:inline\b/.test(attrs) || (type && !/^(?:module|text\/(?:java|type)script|application\/javascript)$/.test(type))) continue;
    const lang = /\blang\s*=\s*["']?(\w+)/.exec(attrs)?.[1] ?? (path.endsWith('.astro') || /typescript/.test(attrs) ? 'ts' : 'js');
    const from = m.index + 7 + attrs.length + 1;
    scripts.push({ code: blank(from, from + m[2].length), loader: LOADERS[lang] ?? (lang === 'tsx' ? 'tsx' : 'ts') });
  }
  return scripts;
}

/**
 * Astro's frontmatter may `return` (Astro.redirect), which no module may: each top-level `return`
 * esbuild reports is replaced by `if(1) `, of the same length, until none is left.
 */
async function astroReturns(code: string, loader: esbuild.Loader): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const errors = await esbuild.transform(code, { loader, logLevel: 'silent' }).then(
      () => [],
      (e: esbuild.TransformFailure) => e.errors ?? [],
    );
    const returns = errors.filter((e) => e.text.startsWith('Top-level return cannot be used') && e.location);
    if (!returns.length) return code;
    const lines = code.split('\n');
    for (const { location } of returns) {
      const line = lines[location!.line - 1];
      if (line.slice(location!.column, location!.column + 6) === 'return') lines[location!.line - 1] = line.slice(0, location!.column) + 'if(1) ' + line.slice(location!.column + 6);
    }
    const next = lines.join('\n');
    if (next === code) return code;
    code = next;
  }
  return code;
}

/** Comments out of JSON with comments (tsconfig.json), where they are not inside a string. */
function parseJsonc(source: string): unknown {
  try {
    return JSON.parse(source.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s: string | undefined) => s ?? '').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/**
 * What a file may import without declaring it: the dependencies of each package.json from its
 * directory up to the project's root (npm hoists a workspace's root dependencies), the workspace
 * packages themselves, an import map's names (a static app's `<script type="importmap">`), and the
 * aliases of tsconfig.json's `paths` and of the build tools' configs (a name quoted in vite.config.ts).
 */
function declaredFor(files: FileTree): (file: string) => Set<string> {
  const shared = new Set<string>();
  const manifests = new Map<string, Set<string>>();
  for (const path of Object.keys(files)) {
    if (/(?:^|\/)node_modules\//.test(path)) continue;
    const source = text(files, path);
    if (source === null) continue;
    const name = path.split('/').at(-1)!;
    if (name === 'package.json') {
      const pkg = parseJsonc(source) as Record<string, unknown> | null;
      if (!pkg) continue;
      const deps = new Set<string>();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const dep of Object.keys((pkg[field] as object | undefined) ?? {})) deps.add(dep);
      manifests.set(path.slice(0, -'package.json'.length), deps);
      if (typeof pkg.name === 'string') shared.add(pkg.name);
    } else if (/^[tj]sconfig(?:\.[\w-]+)?\.json$/.test(name)) {
      const paths = ((parseJsonc(source) as { compilerOptions?: { paths?: object } } | null)?.compilerOptions?.paths ?? {});
      for (const key of Object.keys(paths)) shared.add(key.replace(/\/?\*$/, ''));
    } else if (/\.html?$/.test(name)) {
      for (const m of source.matchAll(/<script[^>]*type\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script>/g)) {
        const map = parseJsonc(m[1]) as { imports?: object; scopes?: Record<string, object> } | null;
        for (const key of [...Object.keys(map?.imports ?? {}), ...Object.values(map?.scopes ?? {}).flatMap((s) => Object.keys(s))]) shared.add(key.replace(/\/$/, ''));
      }
    } else if (/(?:^|\.)config\.[cm]?[jt]s$|^\.babelrc/.test(name)) {
      for (const m of source.matchAll(/["'`]([^"'`\s]{1,100})["'`]\s*:?|\b([\w@$~-]+)\s*:/g)) shared.add((m[1] ?? m[2]).replace(/\/$/, ''));
    }
  }
  return (file) => {
    const declared = new Set(shared);
    for (const [dir, deps] of manifests) if (file.startsWith(dir)) for (const d of deps) declared.add(d);
    return declared;
  };
}

/** Whether a package is declared, or a configured alias covers the specifier. */
function isDeclared(specifier: string, pkg: string, declared: Set<string>): boolean {
  if (declared.has(pkg)) return true;
  for (let at = specifier.length; at > 0; at = specifier.lastIndexOf('/', at - 1)) if (declared.has(specifier.slice(0, at))) return true;
  return false;
}

/** The line of a file's first static import of `specifier` (1 when it is not found as written). */
function importLine(code: string, specifier: string): number {
  const quoted = new RegExp(`\\b(?:from|import)\\s*(["'])${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1`);
  const m = quoted.exec(code);
  return m ? code.slice(0, m.index).split('\n').length : 1;
}

/**
 * Parses the project's own source files and checks their static imports against what it declares.
 * Findings come in file order; a file that does not parse reports its first error only (its
 * imports are not looked at).
 */
export async function checkSources(files: FileTree): Promise<SourceFinding[]> {
  const sources = Object.keys(files)
    .filter((p) => (MODULE.test(p) || COMPONENT.test(p)) && !SKIPPED.test(p) && text(files, p) !== null && (text(files, p) as string).length <= MAX_BYTES)
    .sort()
    .slice(0, MAX_FILES);
  // Each module, by the path esbuild knows it by: a component's scripts are `<file>?script=<n>`.
  const modules = new Map<string, { file: string; code: string; loader: esbuild.Loader }>();
  for (const file of sources) {
    const code = text(files, file) as string;
    if (MODULE.test(file)) modules.set(file, { file, code, loader: LOADERS[file.split('.').at(-1)!] });
    else componentScripts(file, code).forEach((s, i) => modules.set(`${file}?script=${i}`, { file, ...s }));
  }
  if (!modules.size) return [];
  for (const [id, m] of modules) if (m.file.endsWith('.astro')) modules.set(id, { ...m, code: await astroReturns(m.code, m.loader) });

  const imports: { id: string; specifier: string }[] = [];
  const result = await esbuild
    .build({
      entryPoints: [...modules.keys()],
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      jsx: 'preserve',
      tsconfigRaw: '{}',
      plugins: [
        {
          name: 'project-sources',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'entry-point') return { path: args.path, namespace: 'project' };
              if (args.kind === 'import-statement') imports.push({ id: args.importer, specifier: args.path });
              return { path: args.path, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'project' }, (args) => {
              const m = modules.get(args.path)!;
              return { contents: m.code, loader: m.loader };
            });
          },
        },
      ],
    })
    .then(
      () => ({ errors: [] as esbuild.Message[] }),
      (e: esbuild.BuildFailure) => ({ errors: e.errors ?? [] }),
    );

  const findings: SourceFinding[] = [];
  const broken = new Set<string>();
  for (const e of result.errors) {
    const id = e.location?.file.replace(/^project:/, '');
    const m = id ? modules.get(id) : undefined;
    if (!m || !e.location || broken.has(m.file)) continue;
    broken.add(m.file);
    findings.push({ rule: 'compile-error', file: m.file, line: e.location.line, column: e.location.column + 1, message: e.text });
  }
  const declared = declaredFor(files);
  const reported = new Set<string>();
  for (const { id, specifier } of imports) {
    const m = modules.get(id);
    const pkg = packageOf(specifier);
    if (!m || !pkg || broken.has(m.file) || reported.has(`${m.file}\0${pkg}`) || isDeclared(specifier, pkg, declared(m.file))) continue;
    reported.add(`${m.file}\0${pkg}`);
    findings.push({ rule: 'undeclared-import', file: m.file, line: importLine(m.code, specifier), message: pkg });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}
