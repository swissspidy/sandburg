/**
 * Browser-side adapter contract. Bundled into the host page; must not import
 * Node modules.
 */
import type { AdapterErrorCode, FileTree, Framework, InstallReport, PackageJson } from '../types.ts';

export interface AdapterContext {
  signal: AbortSignal;
  packageJson: PackageJson | null;
  framework: Framework;
  log(stream: 'stdout' | 'stderr', line: string): void;
}

export interface RuntimeAdapter {
  readonly name: string;
  mount(files: FileTree, ctx: AdapterContext): Promise<void>;
  /** `hostData` is what the adapter's Node-side hostInstall() returned (if any). */
  install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport>;
  /** Starts the app and returns the URL to load in the app frame (same-origin, or an allowlisted preview origin). */
  start(ctx: AdapterContext): Promise<StartResult>;
  ready?(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface StartResult {
  url: string;
  /** False when start() already loaded the app into the frame (default: true, the host navigates to url). */
  navigate?: boolean;
}

export class AdapterError extends Error {
  code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export type CreateAdapter = () => RuntimeAdapter;
