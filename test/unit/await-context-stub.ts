/**
 * What compiled code calls at each await (await-context.ts), for tests that run compiled code on
 * Node: passes values through and carries no context.
 */
import { AWAIT_CONTEXT_GLOBAL } from '../../src/node-runtime/names.ts';

const g = globalThis as Record<string, unknown>;
g[AWAIT_CONTEXT_GLOBAL] ??= { e: () => ({}), s: (_: unknown, v: unknown) => v, r: (_: unknown, v: unknown) => v, k() {}, x() {} };
