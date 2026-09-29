/**
 * Failure classification (ADR 0001, decision 3). Rules run in order and the
 * first match wins; each result names its rule so a disagreement with the
 * Docker reference can be traced back to the rule that caused it.
 */
import type { CheckResult, Failure, PageError, PhaseName, PhaseRecord, ProbeVerdict } from './types.ts';

/** Error texts that point at a limitation of the in-browser runtime, not the app. */
export const RUNTIME_SIGNATURES: { rule: string; pattern: RegExp }[] = [
  { rule: 'signature:bare-specifier', pattern: /Failed to resolve module specifier|Relative references must start with/i },
  { rule: 'signature:cdn-transform', pattern: /esm\.sh.*(error|failed)|\[esm\.sh\]/i },
  { rule: 'signature:native-addon', pattern: /\.node['"]? (?:is not|cannot)|native (?:module|addon)|node-gyp|NODE_MODULE_VERSION/i },
  { rule: 'signature:stubbed-builtin', pattern: /\b(net|tls|dgram|dns|cluster|worker_threads|child_process)\b.*not (?:supported|implemented)/i },
  { rule: 'signature:esbuild-wasm', pattern: /esbuild(-wasm)?.*(initialize|not available)/i },
];

export interface ClassifyInput {
  probe: ProbeVerdict | null;
  phases: PhaseRecord[];
  checks: CheckResult[];
  pageErrors: PageError[];
  /** Dependency names declared in package.json (dependencies and devDependencies). */
  declaredDependencies: string[];
  /** Set when the orchestrator or browser itself failed (crash, offline cache miss). */
  infraError: { phase: PhaseName; message: string } | null;
}

export function classify(input: ClassifyInput): Failure | null {
  const failedPhase = input.phases.find((p) => p.status === 'failed' || p.status === 'timeout');
  const failedChecks = input.checks.filter((c) => c.blocking && (c.status === 'failed' || c.status === 'error'));
  if (!failedPhase && failedChecks.length === 0 && input.probe?.verdict !== 'unsupported') return null;

  if (failedPhase?.status === 'timeout') {
    return failure('timeout', failedPhase.name, 'phase-deadline', failedPhase.error?.message ?? `${failedPhase.name} timed out`, []);
  }
  if (input.infraError) {
    return failure('infra', input.infraError.phase, 'infra-error', input.infraError.message, []);
  }
  if (input.probe?.verdict === 'unsupported') {
    return failure('runtime-unsupported', 'probe', 'probe-unsupported', input.probe.reason, []);
  }

  const appErrors = input.pageErrors.filter((e) => e.source === 'app').map((e) => e.message);
  // Importing a package the project never declared fails in any environment: that is the app's bug.
  const undeclared = undeclaredImport(appErrors, input.declaredDependencies);
  if (undeclared) {
    return failure('app-bug', failedPhase?.name ?? 'checks', 'undeclared-import', `imports undeclared package "${undeclared}"`, appErrors);
  }
  if (failedPhase) {
    const err = failedPhase.error;
    const message = err?.message ?? `${failedPhase.name} failed`;
    if (err?.code === 'UNSUPPORTED') return failure('runtime-unsupported', failedPhase.name, 'adapter-code:UNSUPPORTED', message, []);
    if (err?.code === 'APP') return failure('app-bug', failedPhase.name, 'adapter-code:APP', message, []);
    const evidence = [message, ...appErrors];
    const sig = matchSignature(evidence);
    if (sig) return failure('runtime-unsupported', failedPhase.name, sig, message, evidence);
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

function undeclaredImport(errors: string[], declared: string[]): string | null {
  for (const text of errors) {
    const m = /Failed to resolve module specifier ["']([^"']+)["']/.exec(text);
    if (!m || m[1].startsWith('.') || m[1].startsWith('/')) continue;
    const parts = m[1].split('/');
    const pkg = m[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!declared.includes(pkg)) return pkg;
  }
  return null;
}

function matchSignature(texts: string[]): string | null {
  for (const { rule, pattern } of RUNTIME_SIGNATURES) {
    if (texts.some((t) => pattern.test(t))) return rule;
  }
  return null;
}

/** An error whose stack runs through served project files (not CDN or runtime code). */
function hasProjectStack(errors: PageError[]): boolean {
  return errors.some((e) => e.source === 'app' && /\/__virtual__\/\d+\/(?!@|node_modules)/.test(e.stack ?? ''));
}

function failure(cls: Failure['class'], phase: PhaseName, rule: string, message: string, evidence: string[]): Failure {
  return { class: cls, phase, rule, message, evidence: evidence.slice(0, 10) };
}
