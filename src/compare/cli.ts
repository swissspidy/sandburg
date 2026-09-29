import type { RunOptions, SessionOptions } from '../orchestrator/session.ts';

export async function compareCommand(
  _target: string,
  _values: Record<string, unknown>,
  _session: SessionOptions,
  _run: RunOptions,
): Promise<number> {
  console.error('compare: not implemented yet');
  return 64;
}
