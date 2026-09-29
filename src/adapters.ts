import { almostnode } from './adapters/almostnode/index.ts';
import type { AdapterDescriptor } from './types.ts';

export const adapters: Record<string, AdapterDescriptor> = {
  almostnode,
};

export function getAdapter(name: string): AdapterDescriptor {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`unknown runtime "${name}" (available: ${Object.keys(adapters).join(', ')})`);
  return adapter;
}
