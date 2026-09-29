/**
 * WordPress Playground adapter (Node half). Runs a WordPress plugin or theme
 * in Playground, loaded at run time from playground.wordpress.net (ADR 0005).
 */
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, Project } from '../../types.ts';

export const wordpress: AdapterDescriptor = {
  name: 'wordpress',
  version: 'playground.wordpress.net',
  browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
  assets: {},
  // Playground's client, remote, PHP/WordPress builds, and wordpress.org downloads.
  egress: ['https://playground.wordpress.net', 'https://wordpress.org', 'https://downloads.wordpress.org', 'https://api.wordpress.org', 'https://*.wp.com'],
  crossOriginIsolation: false,
  appFrameSelectors: ['#wp'],
  probe(project: Project) {
    if (project.framework !== 'wordpress') {
      return { verdict: 'unsupported', reason: `the wordpress adapter runs WordPress plugins and themes, not "${project.framework}"` };
    }
    return { verdict: 'supported' };
  },
};
