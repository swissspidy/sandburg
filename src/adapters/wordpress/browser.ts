/**
 * WordPress Playground adapter (browser half).
 *
 * Boots WordPress (PHP compiled to WebAssembly) with Playground's client and
 * remote from playground.wordpress.net. The client is imported at run time
 * from the same deployment that serves remote.html, as Playground recommends,
 * which keeps the two in sync and keeps GPL code out of Sandburg's bundle.
 * The project (a plugin or a theme) is written into wp-content and activated.
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';

declare const __SANDBURG_PLAYGROUND__: string;
/** The Playground deployment serving client and remote (SANDBURG_PLAYGROUND_URL; see ADR 0005). */
const PLAYGROUND = __SANDBURG_PLAYGROUND__;

/** The subset of Playground's client API the adapter uses. */
interface PlaygroundClient {
  isReady(): Promise<void>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  run(request: { code: string }): Promise<{ text: string; errors: string; exitCode: number }>;
  goTo(path: string): Promise<void>;
}

type Kind = { type: 'plugin'; slug: string; main: string } | { type: 'theme'; slug: string };

export function createAdapter(): RuntimeAdapter {
  let client: PlaygroundClient | null = null;
  let kind: Kind | null = null;

  return {
    name: 'wordpress',

    async mount(files: FileTree, ctx: AdapterContext) {
      kind = detectKind(files, ctx);
      const url = `${PLAYGROUND}/client/index.js`;
      const { startPlaygroundWeb } = (await import(/* @vite-ignore */ url)) as {
        startPlaygroundWeb(options: object): Promise<PlaygroundClient>;
      };
      client = await startPlaygroundWeb({
        iframe: document.getElementById('app') as HTMLIFrameElement,
        remoteUrl: `${PLAYGROUND}/remote.html`,
        blueprint: { preferredVersions: { php: '8.3', wp: 'latest' }, login: true, landingPage: '/' },
      });
      await client.isReady();
      const root = `/wordpress/wp-content/${kind.type === 'plugin' ? 'plugins' : 'themes'}/${kind.slug}`;
      const dirs = new Set<string>([root]);
      for (const path of Object.keys(files)) {
        const parts = path.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) dirs.add(`${root}/${parts.slice(0, i).join('/')}`);
      }
      for (const dir of [...dirs].sort()) await client.mkdir(dir);
      for (const [path, content] of Object.entries(files)) {
        await client.writeFile(`${root}/${path}`, typeof content === 'string' ? content : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0)));
      }
    },

    async install(ctx: AdapterContext): Promise<InstallReport> {
      if (!client || !kind) throw new AdapterError('INTERNAL', 'mount() has not run');
      const activate =
        kind.type === 'plugin'
          ? `require_once ABSPATH . 'wp-admin/includes/plugin.php';
             $r = activate_plugin(${JSON.stringify(`${kind.slug}/${kind.main}`)});
             echo is_wp_error($r) ? 'ERROR: ' . $r->get_error_message() : 'OK';`
          : `$t = wp_get_theme(${JSON.stringify(kind.slug)});
             if (!$t->exists() || $t->errors()) { echo 'ERROR: ' . ($t->errors() ? $t->errors()->get_error_message() : 'theme not found'); }
             else { switch_theme(${JSON.stringify(kind.slug)}); echo 'OK'; }`;
      let res: { text: string; errors: string };
      try {
        res = await client.run({ code: `<?php require_once '/wordpress/wp-load.php'; ${activate}` });
      } catch (err) {
        // Playground throws when PHP exits with a fatal error: loading the project's code failed.
        throw new AdapterError('APP', `activating the ${kind.type} failed: ${String((err as Error).message ?? err).slice(0, 800)}`);
      }
      ctx.log('stdout', res.text);
      if (res.errors) ctx.log('stderr', res.errors);
      if (!res.text.trim().endsWith('OK')) {
        // A fatal error or a WP_Error while activating is the project's fault.
        throw new AdapterError('APP', `activating the ${kind.type} failed: ${(res.text || res.errors).trim().slice(0, 500)}`);
      }
      return { resolution: 'none', lockfileHonored: false, dependencies: {}, buildMs: null };
    },

    async start() {
      if (!client) throw new AdapterError('INTERNAL', 'mount() has not run');
      await client.goTo('/');
      // Playground already renders the site inside #app (remote.html → #wp).
      return { url: '', navigate: false };
    },

    async dispose() {
      client = null;
    },
  };
}

function detectKind(files: FileTree, ctx: AdapterContext): Kind {
  for (const [path, content] of Object.entries(files)) {
    if (!path.includes('/') && path.endsWith('.php') && typeof content === 'string' && /^[ \t/*#@]*Plugin Name:/im.test(content)) {
      return { type: 'plugin', slug: slugify(ctx.packageJson?.name ?? path.replace(/\.php$/, '')), main: path };
    }
  }
  const css = files['style.css'];
  if (typeof css === 'string' && /^[ \t/*#@]*Theme Name:/im.test(css)) {
    const name = /Theme Name:\s*(.+)/i.exec(css)![1].trim();
    return { type: 'theme', slug: slugify(name) };
  }
  throw new AdapterError('APP', 'no plugin header ("Plugin Name:") in a root PHP file and no theme header in style.css');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}
