/**
 * Browser-side adapter contract. Bundled into the host page; must not import
 * Node modules.
 */
import type { AdapterErrorCode, FileTree, InstallReport, PackageJson } from '../types.ts';

export interface AdapterContext {
  signal: AbortSignal;
  packageJson: PackageJson | null;
  log(stream: 'stdout' | 'stderr', line: string): void;
}

export interface RuntimeAdapter {
  readonly name: string;
  mount(files: FileTree, ctx: AdapterContext): Promise<void>;
  install(ctx: AdapterContext): Promise<InstallReport>;
  /** Starts the app and returns a same-origin URL to load in the app frame. */
  start(ctx: AdapterContext): Promise<{ url: string }>;
  ready?(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;
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
