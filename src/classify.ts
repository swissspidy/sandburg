/**
 * Failure classification (ADR 0001, decision 3). Rules run in order and the
 * first match wins; each result names its rule so a disagreement with the
 * Docker reference can be traced back to the rule that caused it.
 */
import { builtinModules } from 'node:module';
import type { CheckResult, Failure, PageError, PhaseName, PhaseRecord, ProbeVerdict } from './types.ts';

/** Node's built-in modules (`sqlite` is only listed with its prefix, as node:sqlite). */
const NODE_BUILTINS = [...builtinModules.filter((m) => !m.startsWith('node:')), 'sqlite'];

/** Error texts that point at a limitation of the in-browser runtime, not the app. */
export const RUNTIME_SIGNATURES: { rule: string; pattern: RegExp }[] = [
  { rule: 'signature:bare-specifier', pattern: /Failed to resolve module specifier|Relative references must start with/i },
  { rule: 'signature:native-addon', pattern: /\.node['"]? (?:is not|cannot)|native (?:module|addon)|node-gyp|NODE_MODULE_VERSION/i },
  { rule: 'signature:stubbed-builtin', pattern: /\b(net|tls|dgram|dns|cluster|worker_threads|child_process)\b.*not (?:supported|implemented)/i },
  // A Node.js built-in the runtime does not implement.
  { rule: 'signature:missing-builtin', pattern: new RegExp(`Cannot find module ['"](?:node:)?(?:${NODE_BUILTINS.join('|')})(?:/[a-z_/]+)?['"]`) },
  // The runtime's emulated Node.js is older than the framework requires.
  { rule: 'signature:node-version', pattern: /Node\.js version >=? ?v?\d+[.\d]* is required|requires Node\.js/i },
  { rule: 'signature:esbuild-wasm', pattern: /esbuild(-wasm)?.*(initialize|not available)|Cannot find module ['"]esbuild-wasm['"]/i },
  // The runtime's own worker failed to boot.
  { rule: 'signature:runtime-worker', pattern: /Initializing node worker failed/i },
  // A package's WebAssembly build trapped in one of its threads (a native build would have crashed too).
  { rule: 'signature:wasm-thread-crash', pattern: /a WebAssembly thread crashed/ },
];

/** A runtime's own download came back broken (an error page instead of an archive, a reset). */
const INFRA_SIGNATURE = /^npm registry: |runtime asset failed to load|404 Not Found - GET https:\/\/registry\.npmjs\.org\/\S+\/-\/\S+\.tgz|Could not unzip file\. Error code: \d+\. File size: \d+ bytes|ERR_TUNNEL_CONNECTION_FAILED|ECONNRESET|socket hang up|upstream proxy refused/i;

/**
 * npm cannot find a package or version (ETARGET, or E404 for a package document). A 404 for a tarball
 * (`/-/name-1.2.3.tgz`) of a version the registry lists is the registry catching up, not the app.
 */
const UNRESOLVABLE_DEPENDENCY = /No matching version found for|404 Not Found - GET https:\/\/registry\.npmjs\.org\/(?:@[^/\s]+%2[fF]|@[^/\s]+\/)?[^/\s-][^/\s]* - Not found/;

const RUNTIME_BOOT_FETCH = /Failed to fetch dynamically imported module|WebWorker failed to load|Failed to register a ServiceWorker/i;

/** Compile errors reported by dev servers and esbuild for the project's sources. */
const COMPILE_ERROR = /Module build failed|Failed to compile|Transform failed with \d+ error|\[plugin:vite:[a-z-]+\]|Expected [^\n]{1,40} but found|Unexpected token|Unterminated (string|template)/i;

export interface ClassifyInput {
  probe: ProbeVerdict | null;
  phases: PhaseRecord[];
  checks: CheckResult[];
  pageErrors: PageError[];
  /** Errors the runtime logged about the project (e.g. NextDevServer's transform errors); used for compile errors only. */
  runtimeErrors?: string[];
  /** The app's output (stdout and stderr), line by line: dev servers report compile errors there. */
  runtimeOutput?: string[];
  /** Dependency names declared in package.json (dependencies and devDependencies). */
  declaredDependencies: string[];
  /** Set when the orchestrator or browser itself failed (crash, offline cache miss). */
  infraError: { phase: PhaseName; message: string } | null;
}

export function classify(input: ClassifyInput): Failure | null {
  // dispose is cleanup: a failure there is recorded but never decides the run's class.
  const failedPhase = input.phases.find((p) => p.name !== 'dispose' && (p.status === 'failed' || p.status === 'timeout'));
  const failedChecks = input.checks.filter((c) => c.blocking && (c.status === 'failed' || c.status === 'error'));
  if (!failedPhase && failedChecks.length === 0 && input.probe?.verdict !== 'unsupported') return null;

  const appErrors = input.pageErrors.filter((e) => e.source === 'app').map((e) => e.message);
  // Importing a package the project never declared fails in any environment: that is the app's bug.
  const output = (input.runtimeOutput ?? []).map((l) => l.replace(ANSI, ''));
  const undeclared = undeclaredImport([failedPhase?.error?.message ?? '', ...appErrors, ...(input.runtimeErrors ?? []), ...output], input.declaredDependencies);
  if (undeclared && failedPhase?.status === 'timeout') {
    return failure('app-bug', failedPhase.name, 'undeclared-import', `imports undeclared package "${undeclared}"`, appErrors);
  }
  // A dev server that cannot compile the project waits for a fix instead of serving it (ng serve).
  const devError = failedPhase ? devServerCompileError(input.runtimeOutput ?? []) : null;
  if (failedPhase?.status === 'timeout' && devError && !matchSignature([devError])) {
    return failure('app-bug', failedPhase.name, 'compile-error', devError, [devError]);
  }
  if (failedPhase?.status === 'timeout') {
    return failure('timeout', failedPhase.name, 'phase-deadline', failedPhase.error?.message ?? `${failedPhase.name} timed out`, []);
  }
  // The runtime could not fetch its own code while booting (before any project code ran).
  if (failedPhase && (failedPhase.name === 'load' || failedPhase.name === 'mount') && RUNTIME_BOOT_FETCH.test(failedPhase.error?.message ?? '')) {
    return failure('infra', failedPhase.name, 'runtime-boot-fetch', failedPhase.error!.message.split('\n')[0], []);
  }
  const infraText = [failedPhase?.error?.message ?? '', ...(input.runtimeErrors ?? [])].find((t) => INFRA_SIGNATURE.test(t));
  if (failedPhase && infraText) {
    return failure('infra', failedPhase.name, 'signature:download-failed', infraText.split('\n').slice(0, 3).join('\n'), []);
  }
  if (input.infraError) {
    return failure('infra', input.infraError.phase, 'infra-error', input.infraError.message, []);
  }
  if (input.probe?.verdict === 'unsupported') {
    return failure('runtime-unsupported', 'probe', 'probe-unsupported', input.probe.reason, []);
  }

  if (undeclared) {
    return failure('app-bug', failedPhase?.name ?? 'checks', 'undeclared-import', `imports undeclared package "${undeclared}"`, appErrors);
  }
  // A dev server (Vite) could not compile one of the project's files: the app's bug, at that location.
  if (failedPhase && devError && !matchSignature([devError])) {
    return failure('app-bug', failedPhase.name, 'compile-error', devError, [devError, ...appErrors]);
  }
  if (failedPhase) {
    const err = failedPhase.error;
    const message = err?.message ?? `${failedPhase.name} failed`;
    // A dependency version or package that does not exist on the registry fails the same way everywhere.
    if (UNRESOLVABLE_DEPENDENCY.test(message)) return failure('app-bug', failedPhase.name, 'unresolvable-dependency', message.split('\n').slice(0, 3).join('\n'), [message]);
    if (err?.code === 'UNSUPPORTED') return failure('runtime-unsupported', failedPhase.name, 'adapter-code:UNSUPPORTED', message, []);
    if (err?.code === 'APP') return failure('app-bug', failedPhase.name, 'adapter-code:APP', message, []);
    const evidence = [message, ...appErrors];
    const sig = matchSignature(evidence);
    if (sig) return failure('runtime-unsupported', failedPhase.name, sig, message, evidence);
    // The project's own source does not compile (dev servers report this for syntax errors).
    const compile = [message, ...appErrors, ...(input.runtimeErrors ?? [])].find((e) => COMPILE_ERROR.test(e));
    if (compile) return failure('app-bug', failedPhase.name, 'compile-error', compile.split('\n').slice(0, 3).join('\n'), evidence);
    // The runtime came up, but the app never rendered and threw from its own sources.
    if (failedPhase.name === 'ready' && hasProjectStack(input.pageErrors)) {
      return failure('app-bug', 'ready', 'app-error-before-ready', message, appErrors);
    }
    return failure('unknown', failedPhase.name, 'unmatched', message, evidence);
  }

  const evidence = [...failedChecks.map((c) => `${c.name}: ${c.message ?? c.status}`), ...appErrors];
  const sig = matchSignature(appErrors);
  if (sig) return failure('runtime-unsupported', 'checks', sig, failedChecks[0].message ?? 'check failed', evidence);
  return failure('app-bug', 'checks', 'blocking-check-failed', `${failedChecks.length} blocking check(s) failed`, evidence);
}

/** How the browser, esbuild, Vite and Node report an import that resolves to nothing. */
const UNRESOLVED_IMPORT = /(?:Failed to resolve module specifier|Could not resolve|Failed to resolve import|Cannot find (?:module|package)) ["']([^"']+)["']/g;

function undeclaredImport(errors: string[], declared: string[]): string | null {
  for (const text of errors) for (const m of text.matchAll(UNRESOLVED_IMPORT)) {
    if (m[1].startsWith('.') || m[1].startsWith('/') || m[1].startsWith('#') || m[1].startsWith('node:')) continue;
    const parts = m[1].split('/');
    const pkg = m[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!declared.includes(pkg) && !NODE_BUILTINS.includes(pkg)) return pkg;
  }
  return null;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Vite's report of a module it could not compile: "[vite] Internal server error: <message>" (or
 * "Pre-transform error"), then "Plugin: …" and "File: /app/<path>:<line>:<column>". Only files of
 * the project count (not dependencies).
 */
export function devServerCompileError(lines: string[]): string | null {
  // Without the stream, and the prefix of a process that concurrently runs ("[client] ").
  const unprefixed = lines.map((l) => l.replace(ANSI, '').replace(/^\[runtime:std(?:err|out)\]\s?/, ''));
  const clean = unprefixed.map((l) => l.replace(/^\[[\w@:./-]{1,40}\]\s/, ''));
  for (let i = 0; i < clean.length; i++) {
    const head = /(?:Internal server error|Pre-transform error): (.+)/.exec(clean[i]);
    if (!head) continue;
    // The location: a "File:" line below, else the path the message starts with ("/app/src/x.tsx: … (2:14)").
    let at: { path: string; loc: string } | null = null;
    // Vite 8 (oxc, rolldown): "Transform failed with 1 error:", then "[PARSE_ERROR] <message>" and a
    // code frame headed "╭─[ app/src/App.tsx:3:1 ]".
    let frame: { path: string; loc: string } | null = null;
    let coded: string | null = null;
    for (let j = i + 1; j < Math.min(clean.length, i + 12) && !at; j++) {
      const file = /^\s*File: \/app\/(\S+?)(:\d+:\d+)?$/.exec(clean[j].trim() ? clean[j] : '');
      if (file) at = { path: file[1], loc: file[2] ?? '' };
      const span = /╭─\[\s*\/?app\/(\S+?)(:\d+:\d+)\s*\]/.exec(clean[j]);
      if (span) frame ??= { path: span[1], loc: span[2] };
      // Before and after a process prefix is removed: "[client] [PARSE_ERROR] …" and "[PARSE_ERROR] …".
      const code = /^\s*\[[A-Z_]+\] (.+)$/.exec(clean[j]) ?? /^\s*\[[A-Z_]+\] (.+)$/.exec(unprefixed[j]);
      if (code) coded ??= code[1].trim();
    }
    if (frame && (!at || (at.path === frame.path && !at.loc))) at = frame;
    const inline = /^\/app\/([^\s:]+)(:\d+:\d+)?:?\s+(.*?)(?:\s+\((\d+):(\d+)\))?$/.exec(head[1].trim());
    if (!at && inline) at = { path: inline[1], loc: inline[2] ?? (inline[4] ? `:${inline[4]}:${inline[5]}` : '') };
    if (!at || /(^|\/)node_modules\//.test(at.path)) continue;
    const message = inline && inline[1] === at.path ? inline[3] + (inline[4] ? ` (${inline[4]}:${inline[5]})` : '') : /^Transform failed with \d+ errors?:$/.test(head[1].trim()) && coded ? coded : head[1].trim();
    return `${at.path}${at.loc}: ${message}`;
  }
  // esbuild's format (the Angular CLI, Vite's dependency scan): "✘ [ERROR] <message>", then "/app/<path>:<line>:<column>:".
  for (let i = 0; i < clean.length; i++) {
    const head = /✘ \[ERROR\] (.+?)(?: \[plugin [^\]]+\])?$/.exec(clean[i]);
    if (!head) continue;
    for (let j = i + 1; j < Math.min(clean.length, i + 5); j++) {
      const at = /^\s+\/app\/(\S+?:\d+:\d+):$/.exec(clean[j]);
      if (at && !/(^|\/)node_modules\//.test(at[1])) return `${at[1]}: ${head[1].trim()}`;
    }
  }
  return null;
}

function matchSignature(texts: string[]): string | null {
  for (const { rule, pattern } of RUNTIME_SIGNATURES) {
    if (texts.some((t) => pattern.test(t))) return rule;
  }
  return null;
}

/**
 * An error whose stack runs through the project's own files (not dependencies or runtime code): served
 * to the page, bundled by webpack (webpack-internal:///(…)/./pages/index.tsx), or run in the runtime.
 */
const PROJECT_FRAME = /(?:https?:\/\/[^/\s]+\/|webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.\/|file:\/\/\/app\/)(?!@|node_modules\/|__sandburg\/|\.next\/|_next\/)[^\s:?()]+\.(?:[cm]?[jt]sx?|vue|svelte|astro)\b/;

function hasProjectStack(errors: PageError[]): boolean {
  return errors.some((e) => e.source === 'app' && PROJECT_FRAME.test(e.stack ?? ''));
}

function failure(cls: Failure['class'], phase: PhaseName, rule: string, message: string, evidence: string[]): Failure {
  return { class: cls, phase, rule, message, evidence: evidence.slice(0, 10) };
}
