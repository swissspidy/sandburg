import { node } from './adapters/node/index.ts';
import type { AdapterDescriptor } from './types.ts';

/** Adapters by name (ADR 0014: every project runs on the node runtime). */
const registry: Record<string, AdapterDescriptor> = {
  node,
};

export const DEFAULT_RUNTIME = 'node';
export const adapterNames = Object.keys(registry);

export function getAdapter(name: string): AdapterDescriptor {
  const adapter = registry[name];
  if (!adapter) throw new Error(`unknown runtime "${name}" (available: ${adapterNames.join(', ')})`);
  return adapter;
}
