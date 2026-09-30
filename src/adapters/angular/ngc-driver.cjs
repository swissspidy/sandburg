'use strict';
/*
 * Sandburg's Angular compile step (ADR 0008). It runs inside the node runtime
 * (a Web Worker), not on the host, and does what @angular/build does before
 * bundling:
 * - an AOT compile with the app's own @angular/compiler-cli and typescript,
 *   including template type-checking,
 * - Sass for component and global styles, with the app's own `sass`.
 *
 * Input: SANDBURG_NGC (JSON). Output: one process.send({ type: 'ngc', … }).
 * With mode "link" it only answers link requests (process.on('message')).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const opts = JSON.parse(process.env.SANDBURG_NGC);
const cwd = process.cwd();

function loadSass() {
  try {
    return require('sass');
  } catch {
    return null;
  }
}

/** Resolves `@use 'pkg/…'` and `~pkg/…` from node_modules, as Angular's Sass setup does. */
function nodeModulesImporter() {
  return {
    findFileUrl(url) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
      const spec = url.replace(/^~/, '');
      const m = /^(@[^/]+\/[^/]+|[^/.][^/]*)(\/.*)?$/.exec(spec);
      if (!m) return null;
      for (let dir = cwd; ; dir = path.dirname(dir)) {
        const pkgDir = path.join(dir, 'node_modules', m[1]);
        if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
          if (m[2]) return pathToFileURL(pkgDir + m[2]);
          const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          const entry = pkg.sass || pkg.style;
          return pathToFileURL(entry ? path.join(pkgDir, entry) : path.join(pkgDir, '_index.scss'));
        }
        if (dir === path.dirname(dir)) return null;
      }
    },
  };
}

function compileSass(sass, source, file, syntax) {
  if (!sass) throw new Error(`${path.relative(cwd, file)}: Sass styles need the "sass" package`);
  const result = sass.compileString(source, {
    url: pathToFileURL(file),
    syntax: syntax === 'sass' ? 'indented' : 'scss',
    loadPaths: (opts.includePaths || []).map((p) => path.resolve(cwd, p)),
    importers: [nodeModulesImporter()],
    silenceDeprecations: ['import'],
    logger: { warn: (message) => process.stderr.write(`Sass warning: ${message}\n`) },
  });
  return result.css;
}

/** Diagnostics as plain text (formatDiagnostics colors them for a terminal). */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function send(result) {
  process.send({ type: 'ngc', ...result, errors: plain(result.errors || ''), warnings: plain(result.warnings || '') });
}

async function main() {
  const t0 = Date.now();
  const ng = require('@angular/compiler-cli');
  const ts = require('typescript');
  const sass = loadSass();

  const config = ng.readConfiguration(path.resolve(cwd, opts.tsConfig));
  if (config.errors.length) return send({ ok: false, errors: ng.formatDiagnostics(config.errors), files: {}, styles: {} });

  const outDir = path.join(cwd, '.sandburg', 'ngc');
  const options = {
    ...config.options,
    outDir,
    rootDir: cwd,
    noEmit: false,
    noEmitOnError: false,
    emitDeclarationOnly: false,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    sourceMap: false,
    inlineSourceMap: true,
    inlineSources: true,
    mapRoot: undefined,
    sourceRoot: undefined,
    // As @angular/build sets them for an application build.
    supportTestBed: false,
    supportJitMode: false,
  };
  const host = ng.createCompilerHost({ options });
  const files = {};
  host.writeFile = (fileName, data) => {
    if (fileName.endsWith('.js')) files[path.relative(outDir, fileName)] = data;
  };
  // Both hooks, as @angular/build sets them: readResource enables the async preanalyze that transformResource needs.
  host.readResource = (file) => fs.readFileSync(file, 'utf8');
  host.transformResource = async (data, ctx) => {
    if (ctx.type !== 'style') return null;
    const file = ctx.resourceFile || ctx.containingFile;
    const lang = ctx.resourceFile ? path.extname(ctx.resourceFile).slice(1) : opts.inlineStyleLanguage || 'css';
    if (lang !== 'scss' && lang !== 'sass') return null;
    return { content: compileSass(sass, data, file, lang) };
  };

  const program = new ng.NgtscProgram(config.rootNames, options, host);
  await program.loadNgStructureAsync();
  const diagnostics = [
    ...program.getTsOptionDiagnostics(),
    ...program.getNgOptionDiagnostics(),
    ...program.getTsSyntacticDiagnostics(),
    ...program.getTsSemanticDiagnostics(),
    ...program.getNgStructuralDiagnostics(),
    ...program.getNgSemanticDiagnostics(),
  ];
  const emit = program.emit();
  diagnostics.push(...emit.diagnostics);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  const warnings = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning);

  // Global Sass styles (angular.json "styles"); CSS ones are bundled as they are.
  const styles = {};
  const styleErrors = [];
  for (const rel of opts.sassStyles || []) {
    const file = path.resolve(cwd, rel);
    try {
      styles[rel] = compileSass(sass, fs.readFileSync(file, 'utf8'), file, path.extname(file).slice(1));
    } catch (e) {
      styleErrors.push(String(e.message || e));
    }
  }

  send({
    ok: errors.length === 0 && styleErrors.length === 0,
    errors: [errors.length ? ng.formatDiagnostics(errors) : '', ...styleErrors].filter(Boolean).join('\n'),
    warnings: warnings.length ? ng.formatDiagnostics(warnings) : '',
    files,
    styles,
    ms: Date.now() - t0,
  });
}

/**
 * The Angular Linker: libraries ship partially compiled (ɵɵngDeclare*); this
 * turns them into full AOT definitions, as @angular/build does with the same
 * Babel plugin from the app's @angular/compiler-cli.
 */
let linker = null;
function link(code, filename) {
  if (!linker) {
    // The Babel that @angular/compiler-cli depends on (it may be nested under it).
    const fromCompiler = require('node:module').createRequire(require.resolve('@angular/compiler-cli'));
    linker = { babel: fromCompiler('@babel/core'), plugin: fromCompiler('@angular/compiler-cli/linker/babel').default };
  }
  const result = linker.babel.transformSync(code, {
    filename,
    cwd,
    configFile: false,
    babelrc: false,
    browserslistConfigFile: false,
    compact: false,
    sourceMaps: false,
    inputSourceMap: false,
    plugins: [[linker.plugin, { linkerJitMode: false }]],
  });
  return result.code;
}

process.on('message', (m) => {
  if (!m || m.type !== 'link') return;
  try {
    process.send({ type: 'linked', id: m.id, code: link(m.code, m.path) });
  } catch (e) {
    process.send({ type: 'linked', id: m.id, error: String((e && e.message) || e) });
  }
});

if (opts.mode === 'link') {
  // A linker-only worker: load Babel and the linker now, while the compile worker runs.
  try {
    link('', path.join(cwd, 'warm-up.js'));
  } catch {
    // reported on the first real request
  }
} else main().catch((e) => {
  const message = String((e && e.stack) || e);
  // A resource (template, stylesheet) that fails to load or compile is the app's error.
  send({ ok: false, errors: message, files: {}, styles: {}, internal: !/Sass|\.s[ac]ss|ENOENT/.test(message) });
});
