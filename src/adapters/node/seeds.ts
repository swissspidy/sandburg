/**
 * Seed runs: the session's own small apps, whose dev-server caches (Next.js' webpack cache, Vite's
 * pre-bundled packages) later apps with the same versions start from.
 */
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFromFiles } from '../../project.ts';
import { NODE_VERSION } from '../../node-runtime/version.ts';
import type { HostInstallOptions, Project } from '../../types.ts';
import { TRANSFORM_VERSION } from './install.ts';
import { viteSeed } from './vite-seed.ts';
import { devCacheRoot } from './installs.ts';

/**
 * Next.js' webpack cache, seeded per version (ADR 0014). In an app's first compile, almost every
 * module is the framework's (React, Next.js' client and server runtimes), the same in every app with
 * the same versions. For each set of versions, the session runs Sandburg's own seed app once; the
 * webpack cache it leaves (with the key Next.js derives the cache version from) is where every later
 * app with those versions starts. Webpack still checks each cached module against its files, so the
 * app's own modules are compiled; a different next.config gives a different cache version, and
 * webpack starts empty. The seed is the session's, never a project's: a project cannot write a cache
 * that another project's run starts from.
 *
 * The cache is in .next/cache, or in .next/dev/cache from Next.js 16 on (next dev builds into
 * .next/dev): a seed that kept .next/cache there kept nothing, and every app compiled from scratch.
 */
const nextSeedDirs = (version: string) => [Number.parseInt(version, 10) >= 16 ? '.next/dev/cache' : '.next/cache'];

const seeding = new Map<string, Promise<void>>();

/**
 * The App Router's seed fits apps with an app directory, the Pages Router's those without: webpack
 * names a module by the index of the loader rule that compiled it (`??ruleSet[1].rules[9]…`), and
 * Next.js has more rules with an app directory, so a Pages Router app found none of its modules in
 * the App Router's seed (its first compile built ~200 of Next.js' modules on the client).
 */
type NextRouter = 'app' | 'pages';

export const nextRouter = (project: Project): NextRouter => (Object.keys(project.files).some((p) => /^(src\/)?app\//.test(p)) ? 'app' : 'pages');

function nextSeedKey(versions: Record<string, string>, router: NextRouter): string {
  return createHash('sha256').update(`next-seed\0${router === 'app' ? '' : `${router}\0`}${JSON.stringify(versions)}\0${NODE_VERSION}\0${TRANSFORM_VERSION}`).digest('hex').slice(0, 24);
}

function nextSeedProject(versions: Record<string, string>, router: NextRouter): { project: Project; checks: Record<string, (ctx: { app: { goto?: unknown }; page: { evaluate(f: () => Promise<unknown>): Promise<unknown> } }) => Promise<void>> } {
  const counter = `import { useState } from 'react';\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>Count {n}</button>;\n}\n`;
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'sandburg-next-seed', private: true, scripts: { dev: 'next dev' }, dependencies: versions }, null, 2),
    ...(router === 'app'
      ? {
          'app/layout.js': `export const metadata = { title: 'Seed' };\nexport default function RootLayout({ children }) {\n  return (<html lang="en"><body>{children}</body></html>);\n}\n`,
          'app/page.js': `import Counter from './counter';\nimport Link from 'next/link';\nexport default function Page() {\n  return (<main><h1>Seed</h1><Counter /><Link href="/about">About</Link></main>);\n}\n`,
          'app/counter.js': `'use client';\n${counter}`,
          'app/about/page.js': `export default function About() {\n  return <p>About</p>;\n}\n`,
          'app/api/ping/route.js': `export async function GET() {\n  return Response.json({ ok: true });\n}\n`,
        }
      : {
          'pages/index.js': `import Head from 'next/head';\nimport Link from 'next/link';\nimport Counter from '../components/counter';\nexport default function Page() {\n  return (<main><Head><title>Seed</title></Head><h1>Seed</h1><Counter /><Link href="/about">About</Link></main>);\n}\n`,
          'components/counter.js': counter,
          'pages/about.js': `export default function About() {\n  return <p>About</p>;\n}\n`,
          'pages/api/ping.js': `export default function handler(req, res) {\n  res.status(200).json({ ok: true });\n}\n`,
        }),
  };
  const name = router === 'app' ? 'next-seed' : `next-${router}-seed`;
  const project = projectFromFiles(files, { name: `sandburg-${name}@${versions.next}`, path: `sandburg:${name}/${versions.next}` });
  // Compile what apps compile first: a page with a client component, another route, a route handler.
  const checks = {
    'the page, a route and a route handler compile': async ({ app }: { app: { getByRole(r: string, o: object): { click(): Promise<void> }; evaluate(f: () => Promise<unknown>): Promise<unknown> } }) => {
      await app.getByRole('button', { name: /Count/ }).click();
      await app.evaluate(() => fetch('/api/ping').then((r) => r.json()));
      await app.getByRole('link', { name: 'About' }).click();
    },
  };
  return { project, checks: checks as never };
}

/**
 * The key of the Vite seed for an app (see vite-seed.ts), and whether its cache exists. A key's
 * second app starts its seed run; apps never wait for one.
 */
export async function viteSeedCache(project: Project, installKey: string, options: HostInstallOptions | undefined, log: (line: string) => void): Promise<{ key: string; ready: boolean } | null> {
  const seed = viteSeed(project, installKey, `${NODE_VERSION}\0${TRANSFORM_VERSION}`);
  if (!seed) return null;
  const stored = () => stat(join(devCacheRoot(), `${seed.key}.json`)).then(() => true, () => false);
  if (options?.seed) return { key: seed.key, ready: false };
  // Seeded when a second app with this key comes: most keys belong to one app, which would pay for
  // a seed run it gains nothing from. The first app pre-bundles on its own, as without seeds.
  const seen = join(devCacheRoot(), `vite-seen-${seed.key}`);
  if (!(await stored()) && !(await stat(seen).then(() => true, () => false))) {
    await mkdir(devCacheRoot(), { recursive: true });
    await writeFile(seen, '');
    return { key: seed.key, ready: false };
  }
  if (await stored()) return { key: seed.key, ready: true };
  // Made beside the app, which does not wait for it: an app pre-bundles its packages in about the
  // time a seed run takes, so waiting would only gain for large packages. Later apps use the seed.
  if (options?.runSeed && !seeding.has(seed.key)) {
    log(`pre-bundling the app's packages in a seed run, for later apps with the same packages and config`);
    seeding.set(seed.key, options.runSeed(seed.project, {}).catch((e: Error) => log(`seeding failed: ${e.message}`)));
  }
  return { key: seed.key, ready: false };
}

/**
 * The key of the Next.js seed cache for an install's versions, and whether it exists. Without one,
 * the seed run starts beside the app, which does not wait for it: a seed run takes ~40 s, and the app
 * compiles Next.js on its own in a few seconds more than with a seed. Later apps use the seed.
 */
export async function nextSeedCache(resolved: Record<string, string>, router: NextRouter, options: HostInstallOptions | undefined, log: (line: string) => void): Promise<{ key: string; ready: boolean; dirs: string[] } | null> {
  const versions = { next: resolved.next, react: resolved.react, 'react-dom': resolved['react-dom'] };
  if (!versions.next || !versions.react || !versions['react-dom']) return null;
  const key = nextSeedKey(versions, router);
  const dirs = nextSeedDirs(versions.next);
  const stored = () => stat(join(devCacheRoot(), `${key}.json`)).then(() => true, () => false);
  if (options?.seed) return { key, ready: false, dirs };
  if (await stored()) return { key, ready: true, dirs };
  if (options?.runSeed && !seeding.has(key)) {
    log(`seeding the webpack cache for next@${versions.next} beside this app (once per set of versions and router)`);
    const seed = nextSeedProject(versions, router);
    seeding.set(key, options.runSeed(seed.project, seed.checks).catch((e: Error) => log(`seeding failed: ${e.message}`)));
  }
  return { key, ready: false, dirs };
}
