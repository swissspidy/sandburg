/**
 * Splits src/adapters/node/index.ts (the node runtime's host side) into the adapter (its routes and
 * descriptor) and modules of what they use, by moving declarations as they are
 * (scripts/split-module.ts), as scripts/split-worker.ts does for the runtime. Run it on a tree
 * where index.ts has not been split, then `npm run typecheck && npm run lint`:
 *
 *   node scripts/split-node-adapter.ts
 *
 * Each move names declarations, not lines, so it can be run again on top of other branches' changes
 * to index.ts. A move fails (and nothing after it runs) when a name is no longer at the top level of
 * index.ts. The installer moves first, so that no module imports index.ts (whose `node` descriptor
 * refers to theirs): the modules form a chain (installs ← dev-cache ← preload ← read-ahead, seeds)
 * without cycles, and are evaluated, in that order, before index.ts's body, as they were in it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { splitModule } from './split-module.ts';

const INDEX = 'src/adapters/node/index.ts';
const at = (p: string) => `src/adapters/node/${p}`;

splitModule(INDEX, at('installs.ts'), ['installer', 'devCacheRoot'], "The installer every run of the node runtime shares, and the directory of the caches kept beside\nits installs.");

splitModule(
  INDEX,
  at('dev-cache.ts'),
  [
    'bundledEntries',
    'DEV_CACHE_DIRS',
    'devCacheKey',
    'CacheWrite',
    'cacheWrites',
    'compileWrites',
    'TOKEN_TTL_MS',
    'DEV_CACHE_MAX',
    'SOURCE_BODY_MAX',
    'issue',
    'issueCacheWrite',
    'issueCompileWrite',
    'granted',
    'cacheEntries',
    'readDevCache',
    'cacheDigests',
    'compileCache',
    'compileKeys',
    'readableCaches',
    'cacheBundle',
    'takeCacheWrite',
    'writeDevCache',
  ],
  "Dev servers' caches kept between runs of a project, and the capabilities that let a run's page\nstore one (a token for one key, from one sandbox, once) or record the host's compiles.",
);

splitModule(
  INDEX,
  at('preload.ts'),
  [
    'PRELOAD_FILE_MAX',
    'preloadLists',
    'preloadDirty',
    'preloadFlush',
    'preloadListPath',
    'preloadSeen',
    'savedPreloadList',
    'readList',
    'PACKAGE_LIST',
    'packageVersions',
    'preloadList',
    'markDirty',
    'flushPreloadLists',
    'packageOf',
    'packageVersion',
    'recordLoad',
    'preloadEntries',
    'issuedBundles',
    'prefetchers',
    'predicted',
    'preloadUrl',
    'bundles',
    'BUNDLES_KEPT',
    'preloadBundle',
    'predictedBundle',
    'PREDICT_WAIT',
    'buildBundle',
    'buildPreloadBundle',
  ],
  "Preload bundles: the files an install's runs load (recorded as they load them, and predicted for\nan install that never ran), sent to the runtime in one response as it starts.",
);

splitModule(
  INDEX,
  at('read-ahead.ts'),
  ['AHEAD_BUDGET', 'AHEAD_FILE_MAX', 'AHEAD_FILES', 'directories', 'directoriesOf', 'readAhead', 'pushed', 'pushAhead', 'nearestPackageJson'],
  "Files sent ahead: with a file the runtime asks for, the files after it in its directory (read\nahead), and the files a module will require next (pushed ahead).",
);

splitModule(
  INDEX,
  at('seeds.ts'),
  ['nextSeedDirs', 'seeding', 'NextRouter', 'nextRouter', 'nextSeedKey', 'nextSeedProject', 'viteSeedCache', 'nextSeedCache'],
  "Seed runs: the session's own small apps, whose dev-server caches (Next.js' webpack cache, Vite's\npre-bundled packages) later apps with the same versions start from.",
);

/** Tests that import the adapter dynamically (after setting SANDBURG_INSTALL_DIR) take the moved names from their modules. */
function replaceIn(file: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)}`);
  writeFileSync(file, text.replaceAll(from, to));
}
const INDEX_TYPE = "typeof import('../../src/adapters/node/index.ts')";
const INDEX_IMPORT = "await import('../../src/adapters/node/index.ts')";
for (const test of ['test/unit/dev-cache-writes.test.ts', 'test/unit/host-bodies.test.ts']) {
  replaceIn(test, `let node: ${INDEX_TYPE};`, `let node: ${INDEX_TYPE} & typeof import('../../src/adapters/node/dev-cache.ts');`);
  replaceIn(test, `node = ${INDEX_IMPORT};`, `node = { ...(${INDEX_IMPORT}), ...(await import('../../src/adapters/node/dev-cache.ts')) };`);
}
replaceIn('test/unit/node-routes.test.ts', `({ serve, cacheEntries } = ${INDEX_IMPORT});`, `({ serve } = ${INDEX_IMPORT});\n  ({ cacheEntries } = await import('../../src/adapters/node/dev-cache.ts'));`);
replaceIn('test/unit/read-ahead.test.ts', `const { pushAhead } = ${INDEX_IMPORT};`, "const { pushAhead } = await import('../../src/adapters/node/read-ahead.ts');");
