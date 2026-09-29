import { almostnode } from './adapters/almostnode/index.ts';
import { nodebox } from './adapters/nodebox/index.ts';
import { wordpress } from './adapters/wordpress/index.ts';
import type { AdapterDescriptor } from './types.ts';

/** Adapters by name. Optional adapters are factories, resolved on first use. */
const registry: Record<string, AdapterDescriptor | (() => AdapterDescriptor)> = {
  almostnode,
  nodebox,
  wordpress,
};

export const adapterNames = Object.keys(registry);

export function getAdapter(name: string): AdapterDescriptor {
  const entry = registry[name];
  if (!entry) throw new Error(`unknown runtime "${name}" (available: ${adapterNames.join(', ')})`);
  if (typeof entry === 'function') registry[name] = entry();
  return registry[name] as AdapterDescriptor;
}
