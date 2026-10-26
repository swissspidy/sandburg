/**
 * Names the host and the runtime both use. The host's code and the runtime's script are built
 * apart (the runtime's by bundle.ts), so each name is defined once here, not copied into each side.
 */

/** First line of code compiled from an ES module (adapters/node/compile.ts writes it; loader.ts and prefetch.ts read it). */
export const ESM_MARKER = '/*sandburg:esm*/';

/** The name of a runtime worker started as a spare for a later thread, and the message that wakes one (threads.ts; bundle.ts's spare script). */
export const SPARE_NAME = 'sandburg-spare';
export const SPARE_WAKE = 'sandburg-spare-wake';

/** Node's conditions for `require`, and for `import` (ES modules are converted to CommonJS, but resolve as imports): the runtime's loader, and the host's prefetcher. */
export const REQUIRE_CONDITIONS: readonly string[] = ['require', 'node', 'module-sync', 'node-addons', 'default'];
export const IMPORT_CONDITIONS: readonly string[] = ['import', 'node', 'module-sync', 'node-addons', 'default'];

/** The global that awaits rewritten to carry async context call (await-context.ts writes the calls; async-context.ts installs it). */
export const AWAIT_CONTEXT_GLOBAL = '__sandburg_ac';
