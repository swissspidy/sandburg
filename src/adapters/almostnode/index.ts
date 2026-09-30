import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, Project } from '../../types.ts';

const require = createRequire(import.meta.url);
// almostnode's exports map hides package.json; its entry lives in <root>/dist/.
const pkgRoot = dirname(dirname(require.resolve('almostnode')));
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };

/** Packages that need native addons or real sockets; almostnode only stubs them. */
const NATIVE_OR_SERVER = ['sharp', 'better-sqlite3', 'sqlite3', 'bcrypt', 'canvas', 'pg-native', 'node-pty'];

export const almostnode: AdapterDescriptor = {
  name: 'almostnode',
  version,
  browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
  assets: {
    '/__sw__.js': fileURLToPath(new URL('./sw.js', import.meta.url)),
    '/__sandburg/almostnode-sw.js': join(pkgRoot, 'dist/__sw__.js'),
  },
  // cdn.tailwindcss.com: NextDevServer injects the Tailwind Play CDN into every page.
  egress: ['https://esm.sh', 'https://unpkg.com', 'https://cdn.tailwindcss.com'],
  crossOriginIsolation: false,
  bundleAliases: {
    'node:zlib': fileURLToPath(new URL('./zlib-stub.ts', import.meta.url)),
  },
  probe(project: Project) {
    if (project.framework !== 'vite' && project.framework !== 'next') {
      return { verdict: 'unsupported', reason: `framework "${project.framework}" is not supported by the almostnode adapter` };
    }
    const deps = project.packageJson?.dependencies ?? {};
    const native = NATIVE_OR_SERVER.filter((name) => name in deps);
    if (native.length) {
      return { verdict: 'unsupported', reason: `native or server-only dependencies: ${native.join(', ')}` };
    }
    return { verdict: 'supported' };
  },
};
