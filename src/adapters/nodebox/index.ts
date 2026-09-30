/**
 * Nodebox adapter (Node half). Optional: @codesandbox/nodebox is under the
 * Sustainable Use License (internal or non-commercial use only), so Sandburg
 * does not depend on it. Install it yourself to use this adapter:
 *
 *   npm install --no-save @codesandbox/nodebox
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, Project } from '../../types.ts';

const require = createRequire(import.meta.url);

function installedVersion(): string | null {
  try {
    const entry = require.resolve('@codesandbox/nodebox');
    return (JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

export function nodebox(): AdapterDescriptor {
  const version = installedVersion();
  if (!version) {
    throw new Error(
      'the nodebox runtime needs @codesandbox/nodebox, which Sandburg does not bundle (Sustainable Use License: ' +
        'internal or non-commercial use only). Install it with: npm install --no-save @codesandbox/nodebox',
    );
  }
  return {
    name: 'nodebox',
    version,
    browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
    assets: {},
    // The runtime iframe, its previews and CodeSandbox's package CDN.
    // The runtime iframe, its previews, CodeSandbox's package CDN, and the npm registry
    // (package metadata and tarballs, cached by the gateway like any other origin).
    egress: ['https://nodebox-runtime.codesandbox.io', 'https://*.codesandbox.io', 'https://*.csb.app', 'https://registry.npmjs.org'],
    crossOriginIsolation: false,
    probe(project: Project) {
      if (project.framework !== 'next' && project.framework !== 'vite') {
        return { verdict: 'unsupported', reason: `framework "${project.framework}" is not supported by the nodebox adapter` };
      }
      // Nodebox emulates Node.js 16.15.1; Next.js 14 and later require Node.js 18.17.
      const next = /(\d+)/.exec(project.packageJson?.dependencies?.next ?? '')?.[1];
      if (next && Number(next) >= 14) {
        return { verdict: 'unsupported', reason: `next@${project.packageJson!.dependencies!.next} needs Node.js >= 18.17; Nodebox emulates 16.15.1` };
      }
      return { verdict: 'supported' };
    },
  };
}
