/** What the host and the page's checks runtime (runtime.ts) exchange: plain data. */

export interface PageChecksOptions {
  checkTimeoutMs: number;
  expectTimeoutMs: number;
}

export interface PageCheckResult {
  name: string;
  /** Failed: an assertion or a wait that timed out (the app misbehaved). Error: the check itself broke. */
  status: 'passed' | 'failed' | 'error';
  message?: string;
  durationMs: number;
}

export type PageChecksOutput = { results: PageCheckResult[] } | { error: string };

declare global {
  interface Window {
    __sandburgPageChecks?: { run(code: string, options: PageChecksOptions): Promise<PageChecksOutput> };
  }
}
