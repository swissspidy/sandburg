/**
 * Messages between the generator page and its key vault (vault.ts). The vault is a sandboxed frame
 * with an opaque origin: it holds the API key and calls the model, so neither the page nor the
 * generated app, which runs on the page's origin, can read the key. Nothing here carries the key.
 */
import type { CallResult, Provider, Turn } from './llm.ts';

/** Settings the page keeps for the vault (it has no storage of its own). None of them is secret. */
export interface Prefs {
  provider: Provider;
  models: Partial<Record<Provider, string>>;
  modelLists: Partial<Record<Provider, { id: string; label: string }[]>>;
  framework: string;
  autofix: boolean;
}

export type ToVault =
  | { type: 'init'; prefs: Prefs; frameworks: { id: string; label: string }[] }
  /** The page's state, for the vault's buttons. */
  | { type: 'state'; busy: boolean; started: boolean; errors: boolean }
  /** An example request, into the request field (the visitor still sends it). */
  | { type: 'fill'; text: string }
  /**
   * A call to the model. The vault makes it only when the visitor asked for it in the vault: once per
   * Generate or Fix click, and up to two error fixes after a Generate click when auto-fix is on.
   */
  | { type: 'call'; id: number; system: string; turns: Turn[]; fix: boolean };

export type FromVault =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'prefs'; prefs: Prefs }
  /** The visitor's request (Generate / Send). */
  | { type: 'submit'; text: string }
  | { type: 'fix' }
  | { type: 'new-app' }
  | { type: 'start'; id: number; model: string }
  | { type: 'text'; id: number; delta: string }
  | { type: 'thinking'; id: number; delta: string }
  | { type: 'done'; id: number; result: CallResult }
  | { type: 'error'; id: number; message: string; aborted: boolean };
