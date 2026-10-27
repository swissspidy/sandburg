/** What the host and the page's checks runtime (runtime.ts) exchange: plain data. */

export interface PageChecksOptions {
  checkTimeoutMs: number;
  expectTimeoutMs: number;
}

export interface PageCheckResult {
  name: string;
  /** Failed: an assertion or a wait that timed out (the app misbehaved). Error: the check itself broke. Skipped: it did not run. */
  status: 'passed' | 'failed' | 'error' | 'skipped';
  message?: string;
  durationMs: number;
}

export type PageChecksOutput = { results: PageCheckResult[] } | { error: string };

declare global {
  interface Window {
    __sandburgPageChecks?: {
      run(code: string, options: PageChecksOptions): Promise<PageChecksOutput>;
      /** Stops the checks (the phase is out of time, `reason`): those that finished, the one running as failed, the rest skipped. */
      stop(reason: string): PageChecksOutput;
    };
  }
}
