export { Session, runProject, DEFAULT_TIMEOUTS } from './orchestrator/session.ts';
export type { RunOptions, RunRenderer, SessionOptions } from './orchestrator/session.ts';
export type { Checks, CheckContext, CheckFn } from './orchestrator/checks.ts';
export { loadPageChecks } from './page-checks/index.ts';
export type { PageChecks } from './page-checks/index.ts';
export { loadProject, projectFromFiles } from './project.ts';
export { classify } from './classify.ts';
export type { ClassifyInput } from './classify.ts';
export { adapterNames, getAdapter } from './adapters.ts';
// The adapter contract (AdapterDescriptor, HostRequest, HostResponse, HostInstallOptions) is Sandburg's own, not the package's.
export type {
  CheckKind,
  CheckResult,
  CheckStatus,
  ConsoleEntry,
  Failure,
  FailureClass,
  FileContent,
  FileTree,
  Framework,
  InstallReport,
  NetworkEntry,
  PackageJson,
  PageError,
  PhaseName,
  PhaseRecord,
  PhaseStatus,
  ProbeVerdict,
  Project,
  RunResult,
  SerializedError,
} from './types.ts';
export { runBatch, discoverProjects } from './orchestrator/batch.ts';
export type { BatchItem, BatchSummary, BatchRunSummary, BatchOptions } from './orchestrator/batch.ts';
export type { NodeRuntime } from './orchestrator/session.ts';
export { dockerReference } from './reference/docker.ts';
export type { DockerReferenceOptions } from './reference/docker.ts';
export { compare } from './compare/compare.ts';
export type { CompareReport, CompareOptions, ComparePair, Rates as CompareRates, SideOutcome, TimingStats } from './compare/compare.ts';
export { renderReport } from './compare/report.ts';
export { SnapshotStore } from './store.ts';
export type { SnapshotManifest, SnapshotRecord } from './store.ts';
