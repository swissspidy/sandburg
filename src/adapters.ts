import { node } from './adapters/node/index.ts';
import type { AdapterDescriptor } from './types.ts';

/** Adapters by name (ADR 0014: every project runs on the node runtime). */
const registry: Record<string, AdapterDescriptor> = {
  node,
};

export const DEFAULT_RUNTIME = 'node';
/** The names of the in-browser runtimes (RunOptions.runtime). */
export const adapterNames = Object.keys(registry);

/** The host-side half of the runtime named `name`; throws for an unknown name. */
export function getAdapter(name: string): AdapterDescriptor {
  const adapter = registry[name];
  if (!adapter) throw new Error(`unknown runtime "${name}" (available: ${adapterNames.join(', ')})`);
  return adapter;
}
