/**
 * Globals this project defines or reads that the DOM and Node typings do not describe. Each is
 * optional where it may be missing, so that reading it still needs a check.
 */

interface Window {
  /** PAGE_QUIET_SCRIPT (orchestrator/session.ts), in each of a run's documents: whether a timer is due within `horizonMs`, and how long the page has not changed. */
  __sandburgQuiet?: (horizonMs: number) => { quiet: boolean; sinceChangeMs: number };
  /** The host page (adapters/node/browser.ts): the files the app wrote that match a pattern. */
  __sandburgReadFiles?: (match: string) => Promise<import('./types.ts').FileTree>;
  /** The host page: an edit to the running app's files (sandburg open, checks that exercise hot reloading). */
  __sandburgWriteFile?: (path: string, content: string) => void;
  /** The host page (adapters/node/process.ts): opens an app page's WebSocket to the app's server, for ws-shim.js. */
  __sandburgWs?: (url: string, protocols: string[], channel: MessagePort) => boolean;
  /** axe-core, once the accessibility check loaded it into the app's frame (orchestrator/checks.ts). */
  axe?: { run(context: Document, options: object): Promise<{ violations: { id: string; impact: string | null; nodes: unknown[] }[] }> };
}

interface Performance {
  /** Chromium's heap figures (non-standard): what the runtime's process.memoryUsage() reports. */
  readonly memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}

/** Where a page serves Sandburg's scripts, when not at /__sandburg (the static demos set it: adapters/node/process.ts). */
declare var __sandburgBase: string | undefined;
/** A page's own service worker and its scope, when not /__sw__.js at / (the static demos set it: adapters/sw-bridge.ts). */
declare var __sandburgServiceWorker: { url: string; scope: string } | undefined;
